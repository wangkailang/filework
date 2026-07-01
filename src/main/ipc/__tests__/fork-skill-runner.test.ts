import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../core/agent/events";
import { DEFAULT_SUB_AGENT_RESULT_SCHEMA } from "../../core/agent/sub-agent-contract";
import type { BeforeToolCallHook } from "../../core/agent/tool-registry";

// ---------------------------------------------------------------------------
// Mock —— AgentLoop 产出预设脚本的事件,依赖项被打桩。
// ---------------------------------------------------------------------------

interface ScriptedRun {
  events: AgentEvent[];
}

const scriptedRuns: ScriptedRun[] = [];
let lastToAiSdkToolsOptions:
  | Parameters<
      {
        toAiSdkTools: (options: {
          beforeToolCall?: BeforeToolCallHook;
        }) => void;
      }["toAiSdkTools"]
    >[0]
  | undefined;
const registeredTools = new Map<
  string,
  {
    name: string;
    execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
  }
>();

function nextScript(): ScriptedRun {
  const r = scriptedRuns.shift();
  if (!r) throw new Error("No scripted AgentLoop run queued");
  return r;
}

vi.mock("../../core/agent/agent-loop", () => ({
  AgentLoop: class {
    async *run(_prompt: string) {
      const { events } = nextScript();
      for (const ev of events) yield ev;
    }
  },
}));

const buildAgentToolRegistry = vi.fn((..._args: unknown[]) => ({
  register: vi.fn(
    (tool: {
      name: string;
      execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
    }) => {
      registeredTools.set(tool.name, tool);
    },
  ),
  toAiSdkTools: vi.fn((options) => {
    lastToAiSdkToolsOptions = options;
    return {};
  }),
}));
vi.mock("../agent-tools", () => ({
  buildAgentToolRegistry: (arg: unknown) => buildAgentToolRegistry(arg),
}));

const buildApprovalHook = vi.fn((..._args: unknown[]) => async () => ({
  allow: true,
}));
vi.mock("../approval-hook", () => ({
  buildApprovalHook: (arg: unknown) => buildApprovalHook(arg),
}));

const getModelAndAdapterByConfigId = vi.fn((..._args: unknown[]) => ({
  model: {} as never,
  adapter: {} as never,
  generationOptions: {},
  providerOptions: {},
}));
vi.mock("../ai-models", () => ({
  getModelAndAdapterByConfigId: (arg?: string) =>
    getModelAndAdapterByConfigId(arg),
}));

vi.mock("../../core/workspace/local-workspace", () => ({
  LocalWorkspace: class {
    constructor(public root: string) {}
  },
}));

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function fakeSender(): WebContents {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

import { createForkSkillRunner } from "../fork-skill-runner";

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("createForkSkillRunner", () => {
  beforeEach(() => {
    scriptedRuns.length = 0;
    lastToAiSdkToolsOptions = undefined;
    registeredTools.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    expect(scriptedRuns.length).toBe(0);
  });

  it("forwards tool_execution events to ai:stream-tool-call / -tool-result", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "tool_execution_start",
          agentId: "t",
          toolCallId: "c1",
          toolName: "readFile",
          args: { path: "/x" },
        },
        {
          type: "tool_execution_end",
          agentId: "t",
          toolCallId: "c1",
          toolName: "readFile",
          result: "hi",
          success: true,
          durationMs: 0,
        },
        { type: "agent_end", agentId: "t", status: "completed" },
      ],
    });

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
    });

    const send = sender.send as ReturnType<typeof vi.fn>;
    const channels = send.mock.calls.map((c) => c[0]);
    expect(channels).toContain("ai:stream-tool-call");
    expect(channels).toContain("ai:stream-tool-result");
    expect(channels).not.toContain("ai:stream-done");
  });

  it("batches deltas into ai:stream-delta", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "message_update",
          agentId: "t",
          messageId: "m",
          deltaText: "Hel",
        },
        {
          type: "message_update",
          agentId: "t",
          messageId: "m",
          deltaText: "lo ",
        },
        {
          type: "message_update",
          agentId: "t",
          messageId: "m",
          deltaText: "world",
        },
        { type: "agent_end", agentId: "t", status: "completed" },
      ],
    });

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await runner({ systemPrompt: "sys", workspacePath: "/ws", prompt: "p" });

    const send = sender.send as ReturnType<typeof vi.fn>;
    const deltaCalls = send.mock.calls.filter(
      (c) => c[0] === "ai:stream-delta",
    );
    expect(deltaCalls.length).toBeGreaterThanOrEqual(1);
    const concatenated = deltaCalls
      .map((c) => (c[1] as { delta: string }).delta)
      .join("");
    expect(concatenated).toBe("Hello world");
  });

  it("on agent_end:failed emits ai:stream-error and returns a failed report", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "agent_end",
          agentId: "t",
          status: "failed",
          error: { message: "rate limit", type: "rate_limit" },
        },
      ],
    });

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    const report = await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
    });

    expect(report.status).toBe("failed");
    expect(report.error).toBe("rate limit");

    const send = sender.send as ReturnType<typeof vi.fn>;
    const errorCalls = send.mock.calls.filter(
      (c) => c[0] === "ai:stream-error",
    );
    expect(errorCalls.length).toBe(1);
    const channels = send.mock.calls.map((c) => c[0]);
    expect(channels).not.toContain("ai:stream-done");
  });

  it("does not throw when parentSignal is already aborted", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "t", status: "cancelled" },
      ],
    });

    const parentCtrl = new AbortController();
    parentCtrl.abort();

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: parentCtrl.signal,
      workspacePath: "/ws",
    });
    const report = await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
    });
    expect(report.status).toBe("cancelled");
  });

  it("passes opts.allowedTools straight through to buildAgentToolRegistry", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "t", status: "completed" },
      ],
    });

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
      allowedTools: ["readFile", "writeFile"],
    });

    expect(buildAgentToolRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: ["readFile", "writeFile"] }),
    );
  });

  it("allows read-only shell inspection for spawned subagents but denies writes and escalation", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "t", status: "completed" },
      ],
    });

    const runner = createForkSkillRunner({
      sender: fakeSender(),
      taskId: "child-1",
      parentTaskId: "parent-1",
      batchId: "batch-1",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
      allowedTools: ["runCommand", "runProcess"],
    });

    const beforeToolCall = lastToAiSdkToolsOptions?.beforeToolCall;
    if (!beforeToolCall) throw new Error("beforeToolCall was not registered");

    await expect(
      beforeToolCall(
        {
          toolName: "runCommand",
          toolCallId: "read-shell",
          args: { command: "find . -maxdepth 2 -type f", cwd: "/ws" },
        },
        {} as never,
      ),
    ).resolves.toEqual({ allow: true });
    await expect(
      beforeToolCall(
        {
          toolName: "runProcess",
          toolCallId: "read-process",
          args: { executable: "rg", args: ["--files"], cwd: "/ws" },
        },
        {} as never,
      ),
    ).resolves.toEqual({ allow: true });
    await expect(
      beforeToolCall(
        {
          toolName: "runCommand",
          toolCallId: "write-shell",
          args: { command: "rm -rf out", cwd: "/ws" },
        },
        {} as never,
      ),
    ).resolves.toMatchObject({
      allow: false,
      reason: expect.stringMatching(/read-only/i),
    });
    await expect(
      beforeToolCall(
        {
          toolName: "runCommand",
          toolCallId: "escalate-shell",
          args: {
            command: "find . -maxdepth 1 -type f",
            cwd: "/ws",
            escalatePermissions: true,
          },
        },
        {} as never,
      ),
    ).resolves.toMatchObject({
      allow: false,
      reason: expect.stringMatching(/escalation/i),
    });
  });

  it("forces allowedTools to [] when the option is undefined (zero-tool default)", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "t", status: "completed" },
      ],
    });

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await runner({ systemPrompt: "sys", workspacePath: "/ws", prompt: "p" });

    expect(buildAgentToolRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: [] }),
    );
  });

  it("registers submitSubagentResult for spawned subagents only", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "child-1",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "child-1", status: "completed" },
      ],
    });

    const childRunner = createForkSkillRunner({
      sender: fakeSender(),
      taskId: "child-1",
      parentTaskId: "parent-1",
      batchId: "batch-1",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await childRunner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
    });

    expect(registeredTools.has("submitSubagentResult")).toBe(true);

    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "legacy",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "legacy", status: "completed" },
      ],
    });
    registeredTools.clear();

    const legacyRunner = createForkSkillRunner({
      sender: fakeSender(),
      taskId: "legacy",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    await legacyRunner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
    });

    expect(registeredTools.has("submitSubagentResult")).toBe(false);
  });

  it("uses submitSubagentResult artifacts as usable partial output when the run is later truncated", async () => {
    const submitted = {
      success: true,
      artifacts: {
        status: "partial",
        coverage: ["/ws/src/main/ipc"],
        findings: [
          {
            claim: "IPC handlers are registered from the main process.",
            evidence: ["/ws/src/main/index.ts:427"],
          },
        ],
        evidence: [],
        missing: ["full handler audit"],
        failureReason: null,
      },
    };
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "child-1",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "tool_execution_start",
          agentId: "child-1",
          toolCallId: "submit-1",
          toolName: "submitSubagentResult",
          args: submitted.artifacts,
        },
        {
          type: "tool_execution_end",
          agentId: "child-1",
          toolCallId: "submit-1",
          toolName: "submitSubagentResult",
          result: submitted,
          success: true,
          durationMs: 0,
        },
        {
          type: "agent_end",
          agentId: "child-1",
          status: "completed",
          stopReason: "token_budget",
          finalText: "startup summary only",
        },
      ],
    });

    const runner = createForkSkillRunner({
      sender: fakeSender(),
      taskId: "child-1",
      parentTaskId: "parent-1",
      batchId: "batch-1",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    const report = await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
      contract: {
        goal: "analyze ipc",
        input: { prompt: "p" },
        output: { format: "json", schema: DEFAULT_SUB_AGENT_RESULT_SCHEMA },
        termination: {},
      },
    });

    expect(report.status).toBe("token_limit");
    expect(report.resultQuality).toBe("usable_partial");
    expect(report.artifacts).toMatchObject({
      status: "partial",
      findings: [
        expect.objectContaining({
          claim: "IPC handlers are registered from the main process.",
        }),
      ],
    });
  });

  it("returns an ok report with summary from agent_end.finalText", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "tool_execution_start",
          agentId: "t",
          toolCallId: "c1",
          toolName: "readFile",
          args: {},
        },
        {
          type: "tool_execution_end",
          agentId: "t",
          toolCallId: "c1",
          toolName: "readFile",
          result: "ok",
          success: true,
          durationMs: 0,
        },
        {
          type: "agent_end",
          agentId: "t",
          status: "completed",
          finalText: "Here is the answer.",
          totalUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      ],
    });

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    const report = await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
    });

    expect(report.status).toBe("ok");
    expect(report.summary).toBe("Here is the answer.");
    expect(report.toolCallCount).toBe(1);
    expect(report.usage.inputTokens).toBe(10);
  });

  it("validates artifacts against contract.output.schema for format=json", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "agent_end",
          agentId: "t",
          status: "completed",
          finalText: 'Here is the result: {"count": 7, "label": "ok"}',
        },
      ],
    });

    const { z } = await import("zod/v4");
    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    const report = await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
      contract: {
        goal: "extract counts",
        input: { prompt: "p" },
        output: {
          format: "json",
          schema: z.object({ count: z.number(), label: z.string() }),
        },
        termination: {},
      },
    });

    expect(report.status).toBe("ok");
    expect(report.artifacts).toEqual({ count: 7, label: "ok" });
  });

  it("downgrades to failed when format=json artifacts miss schema", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        {
          type: "agent_end",
          agentId: "t",
          status: "completed",
          finalText: '{"count":"not-a-number"}',
        },
      ],
    });

    const { z } = await import("zod/v4");
    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
    });
    const report = await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
      contract: {
        goal: "extract",
        input: { prompt: "p" },
        output: { format: "json", schema: z.object({ count: z.number() }) },
        termination: {},
      },
    });
    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/schema validation/);
  });

  it("falls back to default model when modelOverrideId lookup throws", async () => {
    scriptedRuns.push({
      events: [
        {
          type: "agent_start",
          agentId: "t",
          prompt: "p",
          timestamp: "2026-05-09T22:00:00.000Z",
        },
        { type: "agent_end", agentId: "t", status: "completed" },
      ],
    });
    getModelAndAdapterByConfigId.mockImplementationOnce(() => {
      throw new Error("unknown model");
    });
    getModelAndAdapterByConfigId.mockImplementationOnce(() => ({
      model: {} as never,
      adapter: {} as never,
      generationOptions: {},
      providerOptions: {},
    }));

    const sender = fakeSender();
    const runner = createForkSkillRunner({
      sender,
      taskId: "t",
      parentSignal: new AbortController().signal,
      workspacePath: "/ws",
      llmConfigId: "default-cfg",
    });
    await runner({
      systemPrompt: "sys",
      workspacePath: "/ws",
      prompt: "p",
      modelOverrideId: "broken-override",
    });

    expect(getModelAndAdapterByConfigId).toHaveBeenCalledTimes(2);
    expect(getModelAndAdapterByConfigId).toHaveBeenNthCalledWith(
      1,
      "broken-override",
    );
    expect(getModelAndAdapterByConfigId).toHaveBeenNthCalledWith(
      2,
      "default-cfg",
    );
  });
});
