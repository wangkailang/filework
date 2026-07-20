import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageResponse } from "../../ai-elements/message";
import type { ChatMessage } from "../types";

const chatState: {
  value: Record<string, unknown>;
} = {
  value: {},
};

let taskTraceCallback:
  | ((data: {
      taskId: string;
      type: string;
      timestamp: string;
      detail: Record<string, unknown>;
    }) => void)
  | null = null;

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      chat_connectionTimeout: () => "连接超时",
      chat_copied: () => "已复制",
      chat_copy: () => "复制",
      chat_emptyDescription: () => "空状态描述",
      chat_emptyTitle: () => "空状态",
      chat_error: () => "错误",
      chat_forkHere: () => "从这里分叉",
      chat_inputPlaceholder: () => "输入消息",
      chatPermission_autoDesc: () => "在工作区沙箱内自动批准工具调用",
      chatPermission_autoLabel: () => "替我审批",
      chatPermission_fullDesc: () => "不限制文件系统或网络访问",
      chatPermission_fullLabel: () => "完全访问权限",
      chatPermission_label: () => "请求审批",
      chatPermission_requestDesc: () => "敏感操作会先请求确认",
      chatPermission_requestLabel: () => "请求审批",
      chat_retrying: (attempt: string, max: string) => `重试 ${attempt}/${max}`,
      errorType_auth: () => "认证错误",
      errorType_authHint: () => "检查认证",
      errorType_billing: () => "计费错误",
      errorType_billingHint: () => "检查计费",
      errorType_contextOverflow: () => "上下文过长",
      errorType_contextOverflowHint: () => "新建对话",
      errorType_proxyIntercepted: () => "代理拦截",
      errorType_proxyInterceptedHint: () => "检查代理",
      errorType_quotaExceeded: () => "额度已用尽",
      errorType_quotaExceededHint: () => "切换模型",
      errorType_rateLimit: () => "限流",
      errorType_rateLimitHint: () => "稍后再试",
      errorType_serverError: () => "服务错误",
      errorType_serverErrorHint: () => "稍后再试",
      errorType_timeout: () => "超时",
      errorType_timeoutHint: () => "重试",
      errorType_unsupportedModel: () => "模型不可用",
      errorType_unsupportedModelHint: () => "切换模型",
      recovery_newChat: () => "新对话",
      recovery_retry: () => "重试",
      recovery_settings: () => "设置",
      retry_contextOverflow: () => "上下文",
      retry_rateLimit: () => "限流",
      retry_serverError: () => "服务",
      retry_timeout: () => "超时",
      sidebar_skills: () => "技能",
      suggestion_duplicates: () => "查找重复文件",
      suggestion_organize: () => "整理文件",
      suggestion_report: () => "生成报告",
      suggestion_screenshots: () => "整理截图",
      suggestion_stats: () => "统计文件",
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
  useChatSessionContext: () => chatState.value,
}));

vi.mock("../../ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationDownload: () => null,
  ConversationEmptyState: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));

vi.mock("../../ai-elements/message", () => ({
  Message: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MessageAction: ({
    children,
    label,
  }: {
    children: React.ReactNode;
    label?: string;
  }) => (
    <button aria-label={label} type="button">
      {children}
    </button>
  ),
  MessageActionFrame: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MessageActions: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MessageContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MessageResponse: vi.fn(({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  )),
  MessageSkillText: ({ text }: { text: string }) => <span>{text}</span>,
  messageActionsHoverClass: "hover-actions",
}));

vi.mock("../../ai-elements/tool-labels", () => ({
  getToolLabels: () => ({}),
}));

vi.mock("../../ai-elements/plan-viewer", () => ({
  PlanViewer: () => null,
}));

vi.mock("../../ai-elements/prompt-input", () => ({
  PromptInput: ({ children }: { children: React.ReactNode }) => (
    <form>{children}</form>
  ),
  PromptInputAttachButton: () => null,
  PromptInputBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputRichEditor: () => <div data-testid="composer" />,
  PromptInputSubmit: () => (
    <button aria-label="Send" type="submit">
      Enter
    </button>
  ),
}));

vi.mock("../AgentTelemetry", () => ({
  AgentTelemetry: () => null,
}));

vi.mock("../AttachmentChips", () => ({
  AttachmentChips: () => null,
  AttachmentList: () => null,
}));

vi.mock("../MentionMenu", () => ({
  MentionMenu: () => null,
}));

vi.mock("../ModelSelector", () => ({
  ModelSelector: () => null,
}));

vi.mock("../SkillApprovalDialog", () => ({
  SkillApprovalDialog: () => null,
}));

vi.mock("../WorkingIndicator", () => ({
  WorkingIndicator: () => null,
}));

vi.mock("../../settings/WorkspaceMemoryModal", () => ({
  WorkspaceMemoryModal: () => null,
}));

import { ChatPanel } from "../ChatPanel";

const createChatState = (
  messages: ChatMessage[],
  overrides: Record<string, unknown> = {},
) => ({
  activeSessionId: "session-1",
  activeSkill: null,
  chatPermissionMode: "request",
  handleBatchApproval: vi.fn(),
  handleClarificationPick: vi.fn(),
  handleForkSession: vi.fn(),
  handleNewChat: vi.fn(),
  handleSkillApproval: vi.fn(),
  handleStopGeneration: vi.fn(),
  handleSubmit: vi.fn(),
  input: "",
  isLoading: false,
  isPlanGenerating: false,
  isStalled: false,
  lastError: null,
  lastUsage: null,
  messages,
  pendingSkillApproval: null,
  retryInfo: null,
  selectedLlmConfigId: null,
  setChatPermissionMode: vi.fn(),
  setInput: vi.fn(),
  setLastError: vi.fn(),
  setSelectedLlmConfigId: vi.fn(),
  ...overrides,
});

describe("ChatPanel message rendering", () => {
  let root: Root | null = null;

  beforeEach(() => {
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(window, {
      filework: {
        chatAttachBlob: vi.fn(),
        chatAttachFile: vi.fn(),
        llmConfig: {
          get: vi.fn(() =>
            Promise.resolve({
              id: "cfg-1",
              maxOutputTokens: null,
              model: "gpt-5.5",
              modelContextWindow: 258_000,
              modelMaxOutputTokens: null,
            }),
          ),
          list: vi.fn(() => Promise.resolve([])),
        },
        openFiles: vi.fn(() => Promise.resolve([])),
        taskTrace: {
          onEvent: vi.fn((callback) => {
            taskTraceCallback = callback;
            return vi.fn();
          }),
        },
      },
    });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.getElementById("root") as HTMLElement);
    vi.mocked(MessageResponse).mockClear();
    taskTraceCallback = null;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    root = null;
  });

  it("does not rerender unchanged non-last assistant messages when another message is appended", async () => {
    const oldAssistant: ChatMessage = {
      id: "assistant-old",
      sessionId: "session-1",
      role: "assistant",
      content: "旧回答",
      parts: [{ type: "text", text: "旧回答" }],
      timestamp: "2026-06-23T11:00:00.000Z",
    };
    const existingUser: ChatMessage = {
      id: "user-existing",
      sessionId: "session-1",
      role: "user",
      content: "继续",
      timestamp: "2026-06-23T11:01:00.000Z",
    };
    const appendedUser: ChatMessage = {
      id: "user-new",
      sessionId: "session-1",
      role: "user",
      content: "新问题",
      timestamp: "2026-06-23T11:02:00.000Z",
    };

    chatState.value = createChatState([oldAssistant, existingUser]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });
    expect(MessageResponse).toHaveBeenCalledTimes(1);

    chatState.value = createChatState([
      oldAssistant,
      existingUser,
      appendedUser,
    ]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    expect(MessageResponse).toHaveBeenCalledTimes(1);
  });

  it("renders quota exhaustion with the specific backend message", async () => {
    const quotaMessage =
      "GitHub Copilot 额度已用尽。服务端建议等待约 7 天 17 小时 后再试。请切换到其他模型，或等额度恢复后重试。";
    const assistant: ChatMessage = {
      id: "assistant-error",
      sessionId: "session-1",
      role: "assistant",
      content: quotaMessage,
      parts: [
        {
          type: "error",
          message: quotaMessage,
          errorType: "quota_exceeded",
          recoveryActions: ["settings"],
        },
      ],
      timestamp: "2026-06-23T11:03:00.000Z",
    };

    chatState.value = createChatState([assistant]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    const text = document.getElementById("root")?.textContent ?? "";
    expect(text).toContain("额度已用尽");
    expect(text).toContain("GitHub Copilot 额度已用尽");
    expect(text).toContain("7 天 17 小时");
    expect(text).toContain("设置");
    expect(text).not.toContain("切换模型");
  });

  it("hides assistant copy actions while chat is generating", async () => {
    const assistant: ChatMessage = {
      id: "assistant-generating",
      sessionId: "session-1",
      role: "assistant",
      content: "生成中的回答",
      parts: [{ type: "text", text: "生成中的回答" }],
      timestamp: "2026-06-23T11:04:00.000Z",
    };

    chatState.value = createChatState([assistant], { isLoading: true });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "生成中的回答",
    );
    expect(document.querySelector('button[aria-label="复制"]')).toBeNull();

    chatState.value = createChatState([assistant], { isLoading: false });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    expect(document.querySelector('button[aria-label="复制"]')).not.toBeNull();
  });

  it("keeps tool error details collapsed when opening a chat", async () => {
    const assistant: ChatMessage = {
      id: "assistant-tool-error",
      sessionId: "session-1",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool",
          toolCallId: "call-run-command",
          toolName: "runCommand",
          args: { command: "pnpm test" },
          result: "Command failed with exit code 1",
          state: "output-error",
        },
      ],
      timestamp: "2026-06-23T11:06:00.000Z",
    };

    chatState.value = createChatState([assistant]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "runCommand",
    );
    expect(document.getElementById("root")?.textContent ?? "").not.toContain(
      "Command failed with exit code 1",
    );

    const toolTrigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("runCommand"),
    );
    expect(toolTrigger).toBeTruthy();

    await act(async () => {
      toolTrigger?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });

    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "Command failed with exit code 1",
    );
  });

  it("shows the current chat permission mode in the composer footer", async () => {
    chatState.value = createChatState([], {
      chatPermissionMode: "request",
    });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "请求审批",
    );

    chatState.value = createChatState([], {
      chatPermissionMode: "auto",
    });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "替我审批",
    );
  });

  it("shows context usage immediately before the Enter button", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          tokenBudget: 258_000,
          originalTokens: 183_000,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="71% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    expect(usageButton?.textContent).not.toContain("71%");
    const buttons = Array.from(document.querySelectorAll("button"));
    const usageIndex = buttons.indexOf(usageButton as HTMLButtonElement);
    const enterIndex = buttons.findIndex(
      (button) => button.textContent === "Enter",
    );
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(enterIndex);
  });

  it("renders a divider when the assistant context was compressed", async () => {
    chatState.value = createChatState([
      {
        id: "assistant-compressed",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "context-compressed",
            originalTokens: 401_000,
            compressedTokens: 40_000,
          },
          { type: "text", text: "继续执行后续任务。" },
        ],
        timestamp: "2026-06-29T04:00:00.000Z",
      },
    ]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    const marker = document.querySelector('[data-context-compressed="true"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain("上下文已自动压缩");
    expect(marker?.textContent).toContain("401k");
    expect(marker?.textContent).toContain("40k");
  });

  it("shows selected model context before task usage is available", async () => {
    chatState.value = createChatState([], {
      selectedLlmConfigId: "cfg-1",
    });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const usageButton = document.querySelector('button[aria-label*="0% 已用"]');
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    expect(usageButton?.textContent).not.toContain("0%");
    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "已用 0 标记，共 258k",
    );
  });

  it("falls back to known gpt-5.5 context before model metadata arrives", async () => {
    window.filework.llmConfig.get = vi.fn(() =>
      Promise.resolve({
        id: "cfg-1",
        maxOutputTokens: null,
        model: "gpt-5.5",
        modelContextWindow: null,
        modelMaxOutputTokens: null,
      }),
    );
    chatState.value = createChatState([], {
      selectedLlmConfigId: "cfg-1",
    });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const usageButton = document.querySelector('button[aria-label*="0% 已用"]');
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    expect(usageButton?.textContent).not.toContain("0%");
    expect(document.getElementById("root")?.textContent ?? "").toContain(
      "已用 0 标记，共 1.1m",
    );
  });

  it("uses post-compression context tokens from context-budget trace", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 475_000,
          tokenBudget: 247_808,
          usedTokens: 180_000,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="70% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("已用 180k 标记，共 258k");
    expect(rootText).not.toContain("已用 475k 标记，共 258k");
  });

  it("treats provider token-count context-budget traces as actual usage", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 34_500,
          source: "history",
          tokenAccuracy: "actual",
          tokenBudget: 247_808,
          usedTokens: 34_500,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="13% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("已用 35k 标记，共 258k");
    expect(rootText).not.toContain("估算");
  });

  it("shows provider-native compaction status from context-budget trace", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 200_000,
          originalTokens: 170_000,
          providerNativeCompaction: {
            enabled: true,
            mode: "anthropic-context-management-compact",
            provider: "anthropic",
            triggerTokens: 170_000,
          },
          source: "provider-step",
          tokenBudget: 190_000,
          usedTokens: 170_000,
        },
      });
    });

    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("原生压缩已启用：Anthropic");
  });

  it("updates provider-native compaction status when the provider reports it applied", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 200_000,
          originalTokens: 170_000,
          providerNativeCompaction: {
            enabled: true,
            mode: "anthropic-context-management-compact",
            provider: "anthropic",
            triggerTokens: 170_000,
          },
          source: "provider-step",
          tokenBudget: 190_000,
          usedTokens: 170_000,
        },
      });
      taskTraceCallback?.({
        taskId: "task-1",
        type: "provider-native-compaction",
        timestamp: "2026-06-29T04:00:01.000Z",
        detail: {
          applied: true,
          mode: "anthropic-context-management-compact",
          provider: "anthropic",
        },
      });
    });

    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("原生压缩已应用：Anthropic");
    expect(rootText).not.toContain("原生压缩已启用：Anthropic");
  });

  it("lets provider step input usage override a smaller history-only estimate", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 18,
          tokenBudget: 247_808,
        },
      });
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:01.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 31_100,
          source: "provider-step",
          tokenBudget: 247_808,
          usedTokens: 31_100,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="12% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("已用 31k 标记，共 258k");
    expect(rootText).not.toContain("已用 18 标记，共 258k");
  });

  it("does not downgrade provider-measured context usage with a lower estimate", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 34_300,
          source: "provider-step",
          tokenBudget: 247_808,
          usedTokens: 34_300,
        },
      });
      taskTraceCallback?.({
        taskId: "task-2",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:01.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 12_000,
          source: "agent-step",
          tokenBudget: 247_808,
          usedTokens: 12_000,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="13% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("已用 34k 标记，共 258k");
    expect(rootText).not.toContain("已用 12k 标记，共 258k");
  });

  it("keeps provider-measured context usage separate from cumulative input", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 34_500,
          source: "provider-step",
          tokenBudget: 247_808,
          turnIndex: 0,
          usedTokens: 34_500,
        },
      });
      taskTraceCallback?.({
        taskId: "task-2",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:01.000Z",
        detail: {
          contextWindow: 258_000,
          originalTokens: 34_900,
          source: "provider-step",
          tokenBudget: 247_808,
          turnIndex: 0,
          usedTokens: 34_900,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="14% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("已用 35k 标记，共 258k");
    expect(rootText).toContain("累计输入 69k 标记");
    expect(rootText).not.toContain("27% 已用");
  });

  it("restores latest usage input as estimated context usage from existing rows", async () => {
    chatState.value = createChatState(
      [
        {
          id: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: "",
          timestamp: "2026-06-29T04:00:00.000Z",
          parts: [
            {
              inputTokens: 34_500,
              modelId: "gpt-5.5",
              outputTokens: 390,
              provider: "openai",
              totalTokens: 34_890,
              type: "usage",
            },
          ],
        },
        {
          id: "assistant-2",
          sessionId: "session-1",
          role: "assistant",
          content: "",
          timestamp: "2026-06-29T04:00:01.000Z",
          parts: [
            {
              inputTokens: 34_900,
              modelId: "gpt-5.5",
              outputTokens: 22,
              provider: "openai",
              totalTokens: 34_922,
              type: "usage",
            },
          ],
        },
      ],
      {
        selectedLlmConfigId: "cfg-1",
      },
    );
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const usageButton = document.querySelector(
      'button[aria-label*="14% 已用"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("估算");
    expect(rootText).toContain("已用 35k 标记，共 258k");
    expect(rootText).toContain("累计输入 69k 标记");
    expect(rootText).not.toContain("已用 0 标记，共 258k");
  });

  it("does not restore provider input tokens as context usage", async () => {
    chatState.value = createChatState([], {
      lastUsage: {
        inputTokens: 34_700,
        outputTokens: 460,
        totalTokens: 35_160,
        modelId: "gpt-5.5",
        provider: "openai",
      },
      selectedLlmConfigId: "cfg-1",
    });
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const usageButton = document.querySelector('button[aria-label*="0% 已用"]');
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    expect(usageButton?.textContent).not.toContain("0%");
    const rootText = document.getElementById("root")?.textContent ?? "";
    expect(rootText).toContain("已用 0 标记，共 258k");
    expect(rootText).not.toContain("已用 35k 标记，共 258k");
  });

  it("keeps context usage from trace when final provider input tokens are cumulative", async () => {
    chatState.value = createChatState([]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "context-budget",
        timestamp: "2026-06-29T04:00:00.000Z",
        detail: {
          tokenBudget: 258_000,
          originalTokens: 300,
        },
      });
    });
    expect(document.getElementById("root")?.textContent ?? "").toContain("0%");

    await act(async () => {
      taskTraceCallback?.({
        taskId: "task-1",
        type: "task-done",
        timestamp: "2026-06-29T04:00:01.000Z",
        detail: {
          status: "completed",
          inputTokens: 117_900,
          outputTokens: 812,
          totalTokens: 118_712,
        },
      });
    });

    const usageButton = document.querySelector(
      'button[aria-label*="已用 300 标记，共 258k"]',
    );
    expect(
      usageButton?.querySelector('[data-context-usage-ring="true"]'),
    ).not.toBeNull();
    expect(usageButton?.textContent).not.toContain("118k");
    expect(document.getElementById("root")?.textContent ?? "").not.toContain(
      "已用 118k 标记，共 258k",
    );
  });

  it("hides older error banners after the user continues chatting", async () => {
    const oldError = "旧的模型错误";
    const oldAssistant: ChatMessage = {
      id: "assistant-old-error",
      sessionId: "session-1",
      role: "assistant",
      content: oldError,
      parts: [
        {
          type: "error",
          message: oldError,
          errorType: "unsupported_model",
          recoveryActions: ["settings"],
        },
      ],
      timestamp: "2026-06-23T11:03:00.000Z",
    };
    const userMessage: ChatMessage = {
      id: "user-after-error",
      sessionId: "session-1",
      role: "user",
      content: "继续",
      timestamp: "2026-06-23T11:04:00.000Z",
    };
    const currentAssistant: ChatMessage = {
      id: "assistant-current",
      sessionId: "session-1",
      role: "assistant",
      content: "新的回复",
      parts: [{ type: "text", text: "新的回复" }],
      timestamp: "2026-06-23T11:05:00.000Z",
    };

    chatState.value = createChatState([
      oldAssistant,
      userMessage,
      currentAssistant,
    ]);
    await act(async () => {
      root?.render(<ChatPanel workspacePath="/workspace" />);
    });

    const text = document.getElementById("root")?.textContent ?? "";
    expect(text).toContain("继续");
    expect(text).toContain("新的回复");
    expect(text).not.toContain(oldError);
    expect(text).not.toContain("模型不可用");
  });
});
