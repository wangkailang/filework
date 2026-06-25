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
});
