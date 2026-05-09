import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { AgentLoop } from "../agent/agent-loop";
import type { AgentEvent } from "../agent/events";
import { ToolRegistry } from "../agent/tool-registry";
import type { Workspace } from "../workspace/types";

// ---------------------------------------------------------------------------
// Mock the ai package — provides a controllable streamText.
// ---------------------------------------------------------------------------

type FullStreamPart = Record<string, unknown>;

const scriptedRuns: Array<{
  parts: FullStreamPart[];
  totalUsage?: unknown;
  providerMetadata?: unknown;
  /** Throw when fullStream is iterated, after emitting these parts. */
  throwAfter?: Error;
}> = [];

function nextRun() {
  const run = scriptedRuns.shift();
  if (!run) {
    throw new Error("No scripted streamText run queued");
  }
  return run;
}

vi.mock("ai", () => ({
  stepCountIs: vi.fn(() => ({})),
  tool: vi.fn((def: unknown) => def),
  streamText: vi.fn(() => {
    const run = nextRun();
    return {
      fullStream: (async function* () {
        for (const p of run.parts) yield p;
        if (run.throwAfter) throw run.throwAfter;
      })(),
      totalUsage: Promise.resolve(run.totalUsage),
      providerMetadata: Promise.resolve(run.providerMetadata),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubWorkspace(): Workspace {
  return {
    id: "stub:ws",
    kind: "local",
    root: "/stub",
    fs: {} as Workspace["fs"],
    exec: {} as Workspace["exec"],
  };
}

function emptyRegistry(): ToolRegistry {
  return new ToolRegistry();
}

function registryWith(
  ...defs: Array<Parameters<ToolRegistry["register"]>[0]>
): ToolRegistry {
  const r = new ToolRegistry();
  for (const d of defs) r.register(d);
  return r;
}

async function collect(loop: AgentLoop, prompt: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of loop.run(prompt)) out.push(ev);
  return out;
}

const fakeModel = {} as LanguageModel;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop", () => {
  beforeEach(() => {
    scriptedRuns.length = 0;
  });

  afterEach(() => {
    expect(scriptedRuns.length).toBe(0);
  });

  it("emits the canonical event sequence for a text-only turn", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "Hello, " },
        { type: "text-delta", text: "world" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
      totalUsage: { inputTokens: 5, outputTokens: 3 },
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      agentId: "a1",
    });

    const events = await collect(loop, "hi");
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);

    const start = events[0];
    expect(start.type === "agent_start" && start.agentId).toBe("a1");

    const messageEnd = events[5];
    expect(messageEnd.type === "message_end" && messageEnd.finalText).toBe(
      "Hello, world",
    );

    const turnEnd = events[6];
    expect(turnEnd.type === "turn_end" && turnEnd.reason).toBe("finish");

    const end = events[7];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("Hello, world");
    expect(end.totalUsage?.inputTokens).toBe(5);
    expect(end.totalUsage?.totalTokens).toBe(8);
  });

  it("emits tool execution events around tool calls", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "echo",
          input: { msg: "ping" },
        },
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "echo",
          output: "ping",
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "start-step" },
        { type: "text-delta", text: "Done." },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: registryWith({
        name: "echo",
        description: "Echo",
        safety: "safe",
        inputSchema: z.object({ msg: z.string() }),
        execute: async (args: unknown) => (args as { msg: string }).msg,
      }),
      systemPrompt: "system",
    });

    const events = await collect(loop, "say ping");
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      "agent_start",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);

    const toolStart = events[2];
    if (toolStart.type !== "tool_execution_start")
      throw new Error("expected tool_execution_start");
    expect(toolStart.toolName).toBe("echo");
    expect(toolStart.args).toEqual({ msg: "ping" });

    const toolEnd = events[3];
    if (toolEnd.type !== "tool_execution_end")
      throw new Error("expected tool_execution_end");
    expect(toolEnd.success).toBe(true);
    expect(toolEnd.result).toBe("ping");

    const turnEnd1 = events[4];
    expect(turnEnd1.type === "turn_end" && turnEnd1.reason).toBe("tool_calls");
  });

  it("flags a denied tool result as success=false", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        {
          type: "tool-call",
          toolCallId: "c",
          toolName: "rm",
          input: {},
        },
        {
          type: "tool-result",
          toolCallId: "c",
          toolName: "rm",
          output: { success: false, denied: true, reason: "user denied" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
    });

    const events = await collect(loop, "delete it");
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    if (!toolEnd || toolEnd.type !== "tool_execution_end")
      throw new Error("expected tool_execution_end");
    expect(toolEnd.success).toBe(false);
  });

  it("emits context_compressed when transformContext provides metrics", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      hooks: {
        transformContext: async (msgs) => ({
          messages: msgs,
          originalTokens: 1000,
          compressedTokens: 200,
        }),
      },
    });

    const events = await collect(loop, "p");
    const compressed = events.find((e) => e.type === "context_compressed");
    if (!compressed || compressed.type !== "context_compressed")
      throw new Error("expected context_compressed");
    expect(compressed.originalTokens).toBe(1000);
    expect(compressed.compressedTokens).toBe(200);
    expect(events[0].type).toBe("agent_start");
    expect(events[1].type).toBe("context_compressed");
  });

  it("translates AbortError into agent_end{cancelled}", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    scriptedRuns.push({
      parts: [{ type: "start-step" }],
      throwAfter: abortErr,
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
    });

    const events = await collect(loop, "p");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("cancelled");
    expect(end.error).toBeUndefined();
  });

  it("translates other errors into agent_end{failed}", async () => {
    scriptedRuns.push({
      parts: [{ type: "start-step" }],
      throwAfter: new Error("boom"),
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
    });

    const events = await collect(loop, "p");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("failed");
    expect(end.error?.message).toBe("boom");
  });

  it("emits retry event and re-runs the stream when classifier says retryable", async () => {
    scriptedRuns.push({
      parts: [{ type: "start-step" }],
      throwAfter: new Error("flaky 503"),
    });
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "ok" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      classifyError: () => ({
        type: "server_error",
        retryable: true,
        maxRetries: 1,
        backoffMs: 0,
      }),
    });

    const events = await collect(loop, "p");
    const types = events.map((e) => e.type);
    expect(types).toContain("retry");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("ok");
  });
});
