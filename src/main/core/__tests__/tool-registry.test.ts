import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  type BeforeToolCallHook,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
} from "../agent/tool-registry";
import type { Workspace } from "../workspace/types";

function stubWorkspace(): Workspace {
  return {
    id: "stub:workspace",
    kind: "local",
    root: "/stub",
    fs: {} as Workspace["fs"],
    exec: {} as Workspace["exec"],
  };
}

function stubCtx(toolCallId = "call-1"): ToolContext {
  return {
    workspace: stubWorkspace(),
    signal: new AbortController().signal,
    toolCallId,
  };
}

describe("ToolRegistry", () => {
  it("registers and looks up tools by name", () => {
    const reg = new ToolRegistry();
    const echo: ToolDefinition<{ msg: string }, string> = {
      name: "echo",
      description: "Echo input",
      safety: "safe",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (args) => args.msg,
    };
    reg.register(echo);
    expect(reg.has("echo")).toBe(true);
    expect(reg.get("echo")?.name).toBe("echo");
    expect(reg.list().map((t) => t.name)).toEqual(["echo"]);
  });

  it("rejects duplicate registration", () => {
    const reg = new ToolRegistry();
    const noop: ToolDefinition<Record<string, never>, void> = {
      name: "noop",
      description: "No-op",
      safety: "safe",
      inputSchema: z.object({}),
      execute: async () => undefined,
    };
    reg.register(noop);
    expect(() => reg.register(noop)).toThrow(/already registered/);
  });

  it("unregister returns true on hit, false on miss", () => {
    const reg = new ToolRegistry();
    const t: ToolDefinition<Record<string, never>, void> = {
      name: "t",
      description: "",
      safety: "safe",
      inputSchema: z.object({}),
      execute: async () => undefined,
    };
    reg.register(t);
    expect(reg.unregister("t")).toBe(true);
    expect(reg.unregister("t")).toBe(false);
    expect(reg.has("t")).toBe(false);
  });

  describe("toAiSdkTools", () => {
    it("exposes registered tools as ai-sdk Tool entries", () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "addOne",
        description: "Add 1",
        safety: "safe",
        inputSchema: z.object({ n: z.number() }),
        execute: async (args) => args.n + 1,
      });
      const sdkTools = reg.toAiSdkTools({ ctxFactory: () => stubCtx() });
      expect(Object.keys(sdkTools)).toEqual(["addOne"]);
      expect(sdkTools.addOne).toBeDefined();
    });

    it("invokes ctxFactory per call with the right toolCallId", async () => {
      const reg = new ToolRegistry();
      const seen: string[] = [];
      reg.register({
        name: "trace",
        description: "Trace",
        safety: "safe",
        inputSchema: z.object({}),
        execute: async (_args, ctx) => {
          seen.push(ctx.toolCallId);
          return "ok";
        },
      });
      const sdkTools = reg.toAiSdkTools({
        ctxFactory: ({ toolCallId }) => stubCtx(toolCallId),
      });
      const exec = sdkTools.trace.execute as (
        a: unknown,
        o: { toolCallId: string },
      ) => Promise<unknown>;
      await exec({}, { toolCallId: "abc" });
      await exec({}, { toolCallId: "def" });
      expect(seen).toEqual(["abc", "def"]);
    });

    it("routes destructive tools through beforeToolCall and short-circuits on deny", async () => {
      const reg = new ToolRegistry();
      const ran = vi.fn();
      reg.register({
        name: "wipeAll",
        description: "Destructive",
        safety: "destructive",
        inputSchema: z.object({}),
        execute: async () => {
          ran();
          return "should-not-run";
        },
      });

      const beforeToolCall: BeforeToolCallHook = vi
        .fn()
        .mockResolvedValue({ allow: false, reason: "operator denied" });

      const sdkTools = reg.toAiSdkTools({
        ctxFactory: () => stubCtx(),
        beforeToolCall,
      });
      const exec = sdkTools.wipeAll.execute as (
        a: unknown,
        o: { toolCallId: string },
      ) => Promise<unknown>;
      const result = await exec({}, { toolCallId: "x" });

      expect(beforeToolCall).toHaveBeenCalledTimes(1);
      expect(ran).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        denied: true,
        reason: "operator denied",
      });
    });

    it("does not invoke beforeToolCall for safe tools", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "safePing",
        description: "Safe",
        safety: "safe",
        inputSchema: z.object({}),
        execute: async () => "pong",
      });

      const beforeToolCall: BeforeToolCallHook = vi
        .fn()
        .mockResolvedValue({ allow: true });

      const sdkTools = reg.toAiSdkTools({
        ctxFactory: () => stubCtx(),
        beforeToolCall,
      });
      const exec = sdkTools.safePing.execute as (
        a: unknown,
        o: { toolCallId: string },
      ) => Promise<unknown>;
      const result = await exec({}, { toolCallId: "y" });

      expect(beforeToolCall).not.toHaveBeenCalled();
      expect(result).toBe("pong");
    });

    it("uses default reason when beforeToolCall returns no reason", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "danger",
        description: "",
        safety: "destructive",
        inputSchema: z.object({}),
        execute: async () => "ran",
      });

      const sdkTools = reg.toAiSdkTools({
        ctxFactory: () => stubCtx(),
        beforeToolCall: async () => ({ allow: false }),
      });
      const exec = sdkTools.danger.execute as (
        a: unknown,
        o: { toolCallId: string },
      ) => Promise<unknown>;
      const result = (await exec({}, { toolCallId: "z" })) as {
        reason: string;
      };
      expect(result.reason).toBe("Tool call denied");
    });
  });
});
