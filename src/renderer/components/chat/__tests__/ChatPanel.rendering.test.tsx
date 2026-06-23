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
  PromptInputSubmit: () => null,
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

const createChatState = (messages: ChatMessage[]) => ({
  activeSessionId: "session-1",
  activeSkill: null,
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
  setInput: vi.fn(),
  setLastError: vi.fn(),
  setSelectedLlmConfigId: vi.fn(),
});

describe("ChatPanel message rendering", () => {
  let root: Root | null = null;

  beforeEach(() => {
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(window, {
      filework: {
        chatAttachBlob: vi.fn(),
        chatAttachFile: vi.fn(),
        openFiles: vi.fn(() => Promise.resolve([])),
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
