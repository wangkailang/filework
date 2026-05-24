import { describe, expect, it, vi } from "vitest";

import type { McpClient } from "../client";
import { buildMcpToolDefs } from "../tool-bridge";
import type { McpServer } from "../types";

const baseConfig = (over: Partial<McpServer> = {}): McpServer => ({
  id: "srv-1",
  name: "Test Server",
  transport: "stdio",
  command: "echo",
  args: [],
  env: {},
  cwd: null,
  url: null,
  headers: {},
  enabled: true,
  trusted: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const fakeClient = (
  opts: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    callTool?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): McpClient =>
  ({
    getTools: () =>
      opts.tools ?? [
        {
          name: "echo",
          description: "Echo input back",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
        },
      ],
    callTool:
      opts.callTool ??
      (async () => ({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      })),
  }) as unknown as McpClient;

describe("buildMcpToolDefs", () => {
  it("prefixes tool names with mcp__<slug>__", () => {
    const defs = buildMcpToolDefs(baseConfig(), fakeClient());
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("mcp__test_server__echo");
  });

  it("marks tools safe when server is trusted", () => {
    const trusted = buildMcpToolDefs(
      baseConfig({ trusted: true }),
      fakeClient(),
    );
    expect(trusted[0].safety).toBe("safe");

    const untrusted = buildMcpToolDefs(baseConfig(), fakeClient());
    expect(untrusted[0].safety).toBe("destructive");
  });

  it("converts inputSchema to a working zod schema", () => {
    const defs = buildMcpToolDefs(baseConfig(), fakeClient());
    expect(defs[0].inputSchema.safeParse({ msg: "hi" }).success).toBe(true);
    expect(defs[0].inputSchema.safeParse({}).success).toBe(false);
  });

  it("forwards args + signal to client.callTool", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }));
    const defs = buildMcpToolDefs(baseConfig(), fakeClient({ callTool }));
    const signal = new AbortController().signal;
    await defs[0].execute(
      { msg: "hello" },
      { workspace: {} as never, signal, toolCallId: "t-1" },
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("echo", { msg: "hello" }, signal);
  });

  it("throws on isError=true and uses text content as the message", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }));
    const defs = buildMcpToolDefs(baseConfig(), fakeClient({ callTool }));
    await expect(
      defs[0].execute(
        { msg: "x" },
        {
          workspace: {} as never,
          signal: new AbortController().signal,
          toolCallId: "t",
        },
      ),
    ).rejects.toThrow(/boom/);
  });

  it("returns content + structuredContent from successful calls", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { value: 42 },
      isError: false,
    }));
    const defs = buildMcpToolDefs(baseConfig(), fakeClient({ callTool }));
    const out = (await defs[0].execute(
      { msg: "x" },
      {
        workspace: {} as never,
        signal: new AbortController().signal,
        toolCallId: "t",
      },
    )) as { content: unknown[]; structuredContent: { value: number } };
    expect(out.content).toEqual([{ type: "text", text: "ok" }]);
    expect(out.structuredContent).toEqual({ value: 42 });
  });
});
