import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type ToolContext, ToolRegistry } from "../tool-registry";

// 最小化的上下文 —— 下面的占位工具会忽略它。
const ctx = {} as ToolContext;
const execOpts = {
  context: undefined,
  messages: [],
  toolCallId: "call-1",
} satisfies ToolExecutionOptions<unknown>;

function registryWith(execute: (args: unknown) => Promise<unknown>) {
  const registry = new ToolRegistry();
  registry.register({
    name: "webSearch",
    description: "dummy",
    safety: "safe",
    inputSchema: z.object({}),
    execute,
  });
  registry.register({
    name: "createPlan",
    description: "dummy plan",
    safety: "safe",
    inputSchema: z.object({}),
    execute: async () => ({ recorded: true }),
  });
  return registry;
}

describe("toAiSdkTools planGate", () => {
  it("denies a non-createPlan tool when the gate rejects (plan rejected)", async () => {
    const execute = vi.fn(async () => "ran");
    const tools = registryWith(execute).toAiSdkTools({
      ctxFactory: () => ctx,
      planGate: async () => false,
    });

    const res = await tools.webSearch.execute?.({}, execOpts);

    expect(execute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: false, denied: true });
  });

  it("runs the tool when the gate resolves true (approved / no plan)", async () => {
    const execute = vi.fn(async () => "ran");
    const tools = registryWith(execute).toAiSdkTools({
      ctxFactory: () => ctx,
      planGate: async () => true,
    });

    const res = await tools.webSearch.execute?.({}, execOpts);

    expect(execute).toHaveBeenCalledOnce();
    expect(res).toBe("ran");
  });

  it("exempts createPlan from the gate so it can publish the draft", async () => {
    const gate = vi.fn(async () => false);
    const tools = registryWith(async () => "ran").toAiSdkTools({
      ctxFactory: () => ctx,
      planGate: gate,
    });

    const res = await tools.createPlan.execute?.({}, execOpts);

    expect(gate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ recorded: true });
  });
});
