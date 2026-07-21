import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";

const state = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      session_empty: () => "空会话",
      tool_done: () => "完成",
      tool_error: () => "错误",
      tool_errorLabel: () => "错误",
      tool_params: () => "参数",
      tool_preparing: () => "准备中",
      tool_result: () => "结果",
      tool_running: () => "运行中",
    },
  }),
}));

vi.mock("../ChatSessionProvider", () => ({
  useChatSessionContext: () => ({ messages: state.messages }),
}));

vi.mock("../../ai-elements/tool-labels", () => ({
  getToolLabels: () => ({}),
}));

import { SubagentTracePanel } from "../SubagentTracePanel";

describe("SubagentTracePanel", () => {
  it("keeps tool error details collapsed when opening a trace", () => {
    state.messages = [
      {
        id: "assistant-subagent",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-23T11:07:00.000Z",
        parts: [
          {
            type: "subagent",
            batchId: "batch-1",
            toolCallId: "spawn-1",
            concurrency: 1,
            children: [
              {
                childTaskId: "child-1",
                goal: "检查测试失败",
                status: "failed",
                stepCount: 1,
                toolCalls: [
                  {
                    toolCallId: "call-run-command",
                    toolName: "runCommand",
                    state: "output-error",
                  },
                ],
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                },
                parts: [
                  {
                    type: "tool",
                    toolCallId: "call-run-command",
                    toolName: "runCommand",
                    args: { command: "pnpm test" },
                    result: "Subagent command failed",
                    state: "output-error",
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <SubagentTracePanel
        batchId="batch-1"
        childTaskId="child-1"
        workspacePath="/workspace"
      />,
    );

    expect(html).toContain("runCommand");
    expect(html).not.toContain("Subagent command failed");
  });

  it("shows partial child results as usable evidence that still needs follow-up", () => {
    state.messages = [
      {
        id: "assistant-subagent",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-23T11:07:00.000Z",
        parts: [
          {
            type: "subagent",
            batchId: "batch-1",
            toolCallId: "spawn-1",
            concurrency: 1,
            children: [
              {
                childTaskId: "child-1",
                goal: "分析目录",
                status: "token_limit",
                stepCount: 3,
                toolCalls: [],
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                },
                summary: "已有摘要",
                resultQuality: "usable_partial",
              },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <SubagentTracePanel
        batchId="batch-1"
        childTaskId="child-1"
        workspacePath="/workspace"
      />,
    );

    expect(html).toContain("部分可用");
    expect(html).toContain("已有可用证据");
    expect(html).toContain("继续核验剩余缺口");
    expect(html).not.toContain("未产出可采纳结论");
    expect(html).not.toContain("token 超限");
  });

  it("summarizes research calls by discovery, verification, and submission", () => {
    const tool = (
      toolCallId: string,
      toolName: string,
      args: Record<string, unknown>,
      result: unknown,
      state: "output-available" | "output-error" = "output-available",
    ) => ({
      type: "tool" as const,
      toolCallId,
      toolName,
      args,
      result,
      state,
    });
    const verifiedBody = "有证据的页面正文".repeat(20);

    state.messages = [
      {
        id: "assistant-subagent",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-23T11:07:00.000Z",
        parts: [
          {
            type: "subagent",
            batchId: "batch-research",
            toolCallId: "spawn-research",
            concurrency: 1,
            children: [
              {
                childTaskId: "child-research",
                goal: "调研状态管理方案",
                status: "ok",
                stepCount: 10,
                toolCalls: [],
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                },
                resultQuality: "complete",
                parts: [
                  tool(
                    "search-1",
                    "webSearch",
                    { query: "Svelte state management official" },
                    { results: [{ url: "https://svelte.dev/docs" }] },
                  ),
                  tool(
                    "search-2",
                    "webSearch",
                    { query: "Svelte stores comparison" },
                    { results: [{ url: "https://example.com/compare" }] },
                  ),
                  tool(
                    "search-skipped",
                    "webSearch",
                    { query: "repeat search" },
                    {
                      success: true,
                      skipped: true,
                      nextAction: "verify_sources",
                    },
                  ),
                  tool(
                    "fetch-1",
                    "webFetch",
                    { url: "https://svelte.dev/docs/svelte/stores" },
                    { status: 200, markdown: verifiedBody },
                  ),
                  tool(
                    "fetch-2",
                    "webFetchRendered",
                    { url: "https://example.com/compare" },
                    { status: 200, markdown: verifiedBody },
                  ),
                  tool(
                    "fetch-duplicate",
                    "webScrape",
                    { url: "https://svelte.dev/docs/svelte/stores" },
                    { status: 200, markdown: verifiedBody },
                  ),
                  tool(
                    "fetch-thin",
                    "webFetch",
                    { url: "https://thin.example.com" },
                    { status: 200, markdown: "内容不足" },
                  ),
                  tool(
                    "fetch-404",
                    "webFetch",
                    { url: "https://missing.example.com" },
                    { status: 404, markdown: verifiedBody },
                  ),
                  tool(
                    "search-error",
                    "webSearch",
                    { query: "failed search" },
                    "rate limited",
                    "output-error",
                  ),
                  tool(
                    "submit-result",
                    "submitSubagentResult",
                    { status: "complete" },
                    { success: true },
                  ),
                ],
              },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <SubagentTracePanel
        batchId="batch-research"
        childTaskId="child-research"
        workspacePath="/workspace"
      />,
    );

    expect(html).toContain("研究轨迹");
    expect(html).toContain("2 次搜索");
    expect(html).toContain("2 个已核验来源");
    expect(html).toContain("4 次抓取");
    expect(html).toContain("已提交");
    expect(html).toContain("1 次阶段切换");
    expect(html).toContain("2 次失败");
    expect(html).toContain("研究调用明细");
    expect(html).toContain("10 次");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("does not show a research summary for a submit-only subagent", () => {
    state.messages = [
      {
        id: "assistant-subagent",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-23T11:07:00.000Z",
        parts: [
          {
            type: "subagent",
            batchId: "batch-submit-only",
            toolCallId: "spawn-submit-only",
            concurrency: 1,
            children: [
              {
                childTaskId: "child-submit-only",
                goal: "分析本地目录",
                status: "ok",
                stepCount: 1,
                toolCalls: [],
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                },
                resultQuality: "complete",
                parts: [
                  {
                    type: "tool",
                    toolCallId: "submit-only",
                    toolName: "submitSubagentResult",
                    args: { status: "complete" },
                    result: { success: true },
                    state: "output-available",
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <SubagentTracePanel
        batchId="batch-submit-only"
        childTaskId="child-submit-only"
        workspacePath="/workspace"
      />,
    );

    expect(html).toContain("submitSubagentResult");
    expect(html).not.toContain("研究轨迹");
    expect(html).not.toContain("研究调用明细");
  });

  it("shows truncated child results with no usable artifact as no result", () => {
    state.messages = [
      {
        id: "assistant-subagent",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-23T11:07:00.000Z",
        parts: [
          {
            type: "subagent",
            batchId: "batch-1",
            toolCallId: "spawn-1",
            concurrency: 1,
            children: [
              {
                childTaskId: "child-1",
                goal: "分析目录",
                status: "token_limit",
                stepCount: 1,
                toolCalls: [],
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  totalTokens: null,
                },
                summary: "我会先分析目录。",
                resultQuality: "no_result",
              },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <SubagentTracePanel
        batchId="batch-1"
        childTaskId="child-1"
        workspacePath="/workspace"
      />,
    );

    expect(html).toContain("已截断");
    expect(html).toContain("未产出可采纳结论");
    expect(html).not.toContain("部分完成");
  });
});
