import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../core/agent/events";

// ---------------------------------------------------------------------------
// Mocks — AgentLoop yields scripted events, dependencies are stubbed.
// ---------------------------------------------------------------------------

interface ScriptedRun {
  events: AgentEvent[];
}

const scriptedRuns: ScriptedRun[] = [];

function nextScript(): ScriptedRun {
  const r = scriptedRuns.shift();
  if (!r) throw new Error("No scripted AgentLoop run queued");
  return r;
}

vi.mock("../../core/agent/agent-loop", () => ({
  AgentLoop: class {
    constructor(_cfg: unknown) {}
    async *run(_prompt: string) {
      const { events } = nextScript();
      for (const ev of events) yield ev;
    }
  },
}));

const buildAgentToolRegistry = vi.fn((..._args: unknown[]) => ({
  toAiSdkTools: vi.fn(() => ({})),
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
  adapter: { buildProviderOptions: () => ({}) } as never,
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
// Helpers
// ---------------------------------------------------------------------------

function fakeSender(): WebContents {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

import { createForkSkillRunner } from "../fork-skill-runner";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForkSkillRunner", () => {
  beforeEach(() => {
    scriptedRuns.length = 0;
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

  it("on agent_end:failed emits ai:stream-error and returns normally", async () => {
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
    await expect(
      runner({ systemPrompt: "sys", workspacePath: "/ws", prompt: "p" }),
    ).resolves.toBeUndefined();

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
    await expect(
      runner({ systemPrompt: "sys", workspacePath: "/ws", prompt: "p" }),
    ).resolves.toBeUndefined();
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
      adapter: { buildProviderOptions: () => ({}) } as never,
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
