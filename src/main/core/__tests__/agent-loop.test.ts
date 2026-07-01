import { type LanguageModel, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { AgentLoop } from "../agent/agent-loop";
import type { AgentEvent } from "../agent/events";
import { ToolRegistry } from "../agent/tool-registry";
import type { Workspace } from "../workspace/types";

// ---------------------------------------------------------------------------
// 模拟 ai 包 —— 提供一个可控的 streamText。
// ---------------------------------------------------------------------------

type FullStreamPart = Record<string, unknown>;

const scriptedRuns: Array<{
  parts: FullStreamPart[];
  totalUsage?: unknown;
  providerMetadata?: unknown;
  /** 在发出这些分块后、迭代 stream/fullStream 时抛出。 */
  throwAfter?: Error;
  /** 发出分块后、结束/抛出前 await 的毫秒数(用于让墙钟定时器有机会触发)。 */
  holdMs?: number;
  /** 模拟 AI SDK v7 只暴露 stream 的结果形态。 */
  streamOnly?: boolean;
}> = [];

function nextRun() {
  const run = scriptedRuns.shift();
  if (!run) {
    throw new Error("No scripted streamText run queued");
  }
  return run;
}

vi.mock("ai", () => ({
  isStepCount: vi.fn(() => ({})),
  tool: vi.fn((def: unknown) => def),
  streamText: vi.fn(
    (options?: {
      messages?: unknown[];
      prepareStep?: (args: {
        initialMessages: unknown[];
        messages: unknown[];
        responseMessages: unknown[];
        stepNumber: number;
      }) => unknown;
    }) => {
      const run = nextRun();
      options?.prepareStep?.({
        initialMessages: options.messages ?? [],
        messages: options.messages ?? [],
        responseMessages: [],
        stepNumber: 0,
      });
      const stream = (async function* () {
        for (const p of run.parts) yield p;
        if (run.holdMs)
          await new Promise((resolve) => setTimeout(resolve, run.holdMs));
        if (run.throwAfter) throw run.throwAfter;
      })();
      return {
        ...(run.streamOnly ? {} : { fullStream: stream }),
        stream,
        fullStream: run.streamOnly ? undefined : stream,
        totalUsage: Promise.resolve(run.totalUsage),
        providerMetadata: Promise.resolve(run.providerMetadata),
      };
    },
  ),
}));

// ---------------------------------------------------------------------------
// 辅助函数
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
// 测试
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
        {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 3 },
        },
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
    expect(turnEnd.type === "turn_end" && turnEnd.usage?.inputTokens).toBe(5);

    const end = events[7];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("Hello, world");
    expect(end.totalUsage?.inputTokens).toBe(5);
    expect(end.totalUsage?.totalTokens).toBe(8);
  });

  it("consumes the AI SDK v7 stream result while preserving the text event contract", async () => {
    scriptedRuns.push({
      streamOnly: true,
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "v7 " },
        { type: "text-delta", text: "stream" },
        {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      ],
      totalUsage: { inputTokens: 2, outputTokens: 2 },
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      agentId: "v7",
    });

    const events = await collect(loop, "hi");
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    const end = events.at(-1);
    if (end?.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("v7 stream");
  });

  it("passes v7 instructions to streamText instead of the deprecated system option", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "ok" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system instructions",
    });

    await collect(loop, "hi");

    const call = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.instructions).toBe("system instructions");
    expect("system" in call).toBe(false);
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

  it("tool-error part 应产出 tool_execution_end{success=false}", async () => {
    // AI SDK 会将抛出异常的工具 `execute`（例如 MCP 超时 / 未连接）
    // 转换为 `tool-error` 的 stream 分块。若不显式处理该分块，
    // 它会被悄无声息地丢弃，导致工具气泡永远卡在「执行中」。
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        {
          type: "tool-call",
          toolCallId: "call-err",
          toolName: "mcp__email__email_search",
          input: { accountId: "a", limit: 10 },
        },
        {
          type: "tool-error",
          toolCallId: "call-err",
          toolName: "mcp__email__email_search",
          input: { accountId: "a", limit: 10 },
          error: new Error('MCP server "email" is not connected'),
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "start-step" },
        { type: "text-delta", text: "connection problem" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
    });

    const events = await collect(loop, "check my mail");
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    if (!toolEnd || toolEnd.type !== "tool_execution_end")
      throw new Error("expected tool_execution_end for the failed tool call");
    expect(toolEnd.toolCallId).toBe("call-err");
    expect(toolEnd.success).toBe(false);
    expect(toolEnd.result).toMatchObject({
      success: false,
      error: 'MCP server "email" is not connected',
    });

    // 整个回合仍会完成 —— 该错误不得中止 agent。
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
  });

  it("reflect 回合摘要中应把 tool-error 记为 success=false", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        {
          type: "tool-call",
          toolCallId: "te",
          toolName: "boom",
          input: {},
        },
        {
          type: "tool-error",
          toolCallId: "te",
          toolName: "boom",
          input: {},
          error: "kaboom",
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "start-step" },
        { type: "text-delta", text: "recovered" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    let captured: unknown;
    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      hooks: {
        reflect: async (s) => {
          captured = s;
          return { kind: "continue" };
        },
      },
    });

    await collect(loop, "go");
    expect(captured).toMatchObject({
      toolCalls: [expect.objectContaining({ name: "boom", success: false })],
    });
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

  it("reports prepared step context after tool-result compaction", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const reports: Array<{
      messages: unknown[];
      preparedMessages: unknown[];
    }> = [];
    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      history: [
        { role: "user", content: "inspect" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "old",
              toolName: "runCommand",
              output: { type: "text", value: "a".repeat(5000) },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "latest",
              toolName: "runCommand",
              output: { type: "text", value: "fresh result" },
            },
          ],
        },
      ],
      hooks: {
        contextUsage: ((payload: {
          messages: unknown[];
          preparedMessages: unknown[];
        }) => {
          reports.push(payload);
        }) as never,
      },
    });

    await collect(loop, "inspect");

    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0].messages)).toContain("a".repeat(5000));
    expect(JSON.stringify(reports[0].preparedMessages)).toContain(
      "chars elided to save context",
    );
  });

  it("does not append a text-only duplicate when history already contains the current image turn", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "这里有图" },
            {
              type: "image",
              image: new Uint8Array([1, 2, 3]),
              mediaType: "image/png",
            },
          ],
        },
      ],
    });

    await collect(loop, "这里有图");

    const call = streamTextSpy.mock.calls[0][0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "这里有图" },
        { type: "image", mediaType: "image/png" },
      ],
    });
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

  it("preserves streamed text in agent_end when abort happens before finish-step", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "RESULT_JSON\n" },
        { type: "text-delta", text: '{"status":"complete"}' },
      ],
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
    expect(end.finalText).toBe('RESULT_JSON\n{"status":"complete"}');
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

  it("preserves classifier user message and recovery actions on failed agent_end", async () => {
    scriptedRuns.push({
      parts: [{ type: "start-step" }],
      throwAfter: new Error("Failed after 3 attempts. Last error:"),
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      classifyError: () => ({
        backoffMs: 0,
        maxRetries: 0,
        recoveryActions: ["settings"],
        retryable: false,
        type: "quota_exceeded",
        userMessage: "GitHub Copilot 额度已用尽。请切换到其他模型。",
      }),
    });

    const events = await collect(loop, "p");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("failed");
    expect(end.error).toMatchObject({
      message: "GitHub Copilot 额度已用尽。请切换到其他模型。",
      recoveryActions: ["settings"],
      type: "quota_exceeded",
    });
  });

  it("invokes reflect hook and loops when verdict=retry", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "first" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "corrected" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const seenFinalTexts: string[] = [];
    const reflectMock = vi
      .fn()
      .mockResolvedValueOnce({ kind: "retry", feedback: "do better" })
      .mockResolvedValueOnce({ kind: "continue" });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      hooks: {
        reflect: async (summary, signal) => {
          seenFinalTexts.push(summary.finalText);
          return reflectMock(summary, signal);
        },
      },
      maxReflections: 2,
    });

    const events = await collect(loop, "hi");
    const types = events.map((e) => e.type);

    expect(types).toContain("reflection_verdict");
    expect(reflectMock).toHaveBeenCalledTimes(2);
    expect(seenFinalTexts).toEqual(["first", "corrected"]);

    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("corrected");
  });

  it("emits failed agent_end with reflection_aborted when verdict=abort", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "bad" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      hooks: {
        reflect: async () => ({ kind: "abort", reason: "loop detected" }),
      },
    });

    const events = await collect(loop, "hi");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("failed");
    expect(end.error?.type).toBe("reflection_aborted");
    expect(end.error?.message).toBe("loop detected");
  });

  it("respects maxReflections and stops looping after the cap", async () => {
    for (let i = 0; i < 3; i++) {
      scriptedRuns.push({
        parts: [
          { type: "start-step" },
          { type: "text-delta", text: `attempt-${i}` },
          { type: "finish-step", finishReason: "stop", usage: {} },
        ],
      });
    }

    const reflectMock = vi
      .fn()
      .mockResolvedValue({ kind: "retry", feedback: "more" });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      hooks: { reflect: reflectMock },
      maxReflections: 2,
    });

    const events = await collect(loop, "hi");
    expect(reflectMock).toHaveBeenCalledTimes(2);
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("attempt-2");
  });

  it("strips tools on the retry pass when verdict carries forceNoTools=true", async () => {
    // 第一轮：模型输出文本但没有 FINAL ANSWER（此处已 mock 掉 ——
    // 该测试只检查工具集的接线，而非规则本身）。
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "thinking out loud..." },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    // 第二轮（无工具重试）：输出最终答案。
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "FINAL ANSWER: 42" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    const reflectMock = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "retry",
        feedback: "emit FINAL ANSWER",
        forceNoTools: true,
      })
      .mockResolvedValueOnce({ kind: "continue" });

    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

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
      hooks: { reflect: reflectMock },
      maxReflections: 2,
    });

    const events = await collect(loop, "hi");

    expect(streamTextSpy).toHaveBeenCalledTimes(2);
    const firstTools = (streamTextSpy.mock.calls[0][0] as { tools: unknown })
      .tools as Record<string, unknown>;
    const secondTools = (streamTextSpy.mock.calls[1][0] as { tools: unknown })
      .tools as Record<string, unknown>;
    expect(Object.keys(firstTools)).toContain("echo");
    expect(secondTools).toEqual({});

    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.finalText).toBe("FINAL ANSWER: 42");
  });

  it("only clears tools for one pass — a subsequent retry without forceNoTools restores tools", async () => {
    // 3 个脚本轮次：每轮输出一些文本后停止。
    for (let i = 0; i < 3; i++) {
      scriptedRuns.push({
        parts: [
          { type: "start-step" },
          { type: "text-delta", text: `pass-${i}` },
          { type: "finish-step", finishReason: "stop", usage: {} },
        ],
      });
    }

    const reflectMock = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "retry",
        feedback: "no tools",
        forceNoTools: true,
      })
      // 第二次裁决重新启用工具（不带 forceNoTools）。
      .mockResolvedValueOnce({ kind: "retry", feedback: "try again" })
      .mockResolvedValueOnce({ kind: "continue" });

    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

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
      hooks: { reflect: reflectMock },
      // 需要 3 次反思才能到达第三轮。
      maxReflections: 3,
    });

    await collect(loop, "hi");

    expect(streamTextSpy).toHaveBeenCalledTimes(3);
    const toolsForCall = (i: number) =>
      (streamTextSpy.mock.calls[i][0] as { tools: unknown }).tools as Record<
        string,
        unknown
      >;
    expect(Object.keys(toolsForCall(0))).toContain("echo"); // 初始
    expect(toolsForCall(1)).toEqual({}); // 无工具重试
    expect(Object.keys(toolsForCall(2))).toContain("echo"); // 工具已恢复
  });

  it("passes turn summary with collected tool calls to reflect hook", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "readPdf",
          input: {},
        },
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "readPdf",
          output: { success: false, error: "pdf parse failed" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "start-step" },
        { type: "text-delta", text: "ok done" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });

    let captured: unknown;
    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      hooks: {
        reflect: async (s) => {
          captured = s;
          return { kind: "continue" };
        },
      },
    });

    await collect(loop, "read a pdf");
    expect(captured).toMatchObject({
      finalText: "ok done",
      toolCalls: [expect.objectContaining({ name: "readPdf", success: false })],
    });
  });

  it("passes temperature to streamText when configured", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "ok" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      temperature: 0,
    });
    await collect(loop, "hi");

    const call = streamTextSpy.mock.calls[0][0] as { temperature?: number };
    expect(call.temperature).toBe(0);
  });

  it("passes topP and maxOutputTokens to streamText when configured", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "ok" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
      topP: 0.8,
      maxOutputTokens: 4096,
    });
    await collect(loop, "hi");

    const call = streamTextSpy.mock.calls[0][0] as {
      maxOutputTokens?: number;
      topP?: number;
    };
    expect(call.topP).toBe(0.8);
    expect(call.maxOutputTokens).toBe(4096);
  });

  it("omits temperature when not configured (preserves provider default)", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "ok" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
    });
    const streamTextSpy = vi.mocked(streamText);
    streamTextSpy.mockClear();

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "",
    });
    await collect(loop, "hi");

    const call = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect("temperature" in call).toBe(false);
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

  // ── 三个硬上限 ────────────────────────────────────────────────────────

  it("token 累计超 maxTotalTokens → agent_end{completed, stopReason:token_budget} 且不触发 reflect", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "big" },
        {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 80, outputTokens: 40 },
        },
      ],
    });

    const reflectMock = vi.fn().mockResolvedValue({ kind: "continue" });
    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      hooks: { reflect: reflectMock },
      maxTotalTokens: 50,
    });

    const events = await collect(loop, "hi");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.stopReason).toBe("token_budget");
    // 命中预算应在 reflect 之前 short-circuit。
    expect(reflectMock).not.toHaveBeenCalled();
  });

  it("墙钟超 maxWallMs → agent_end{completed, stopReason:wall_clock}", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "slow" },
        { type: "finish-step", finishReason: "stop", usage: {} },
      ],
      // 在流末 hold 30ms,让 5ms 的墙钟定时器先触发。
      holdMs: 30,
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      maxWallMs: 5,
    });

    const events = await collect(loop, "hi");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.stopReason).toBe("wall_clock");
  });

  it("正常完成时 stopReason 为 undefined(回归)", async () => {
    scriptedRuns.push({
      parts: [
        { type: "start-step" },
        { type: "text-delta", text: "done" },
        {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 3 },
        },
      ],
    });

    const loop = new AgentLoop({
      workspace: stubWorkspace(),
      model: fakeModel,
      tools: emptyRegistry(),
      systemPrompt: "system",
      maxTotalTokens: 100_000,
      maxWallMs: 60_000,
    });

    const events = await collect(loop, "hi");
    const end = events[events.length - 1];
    if (end.type !== "agent_end") throw new Error("expected agent_end");
    expect(end.status).toBe("completed");
    expect(end.stopReason).toBeUndefined();
  });
});
