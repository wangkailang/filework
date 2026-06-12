import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../chat/types";

const chatState = vi.hoisted(() => ({
  value: null as unknown,
}));

vi.mock("../../chat/ChatSessionProvider", () => ({
  useChatSessionLite: () => chatState.value,
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    locale: "zh-CN",
    LL: {
      chat_generating: () => "正在生成",
      session_cancel: () => "取消",
      session_close: () => "关闭",
      session_delete: () => "删除",
      session_delete_confirm_desc: () => "删除后不可恢复",
      session_delete_confirm_title: () => "删除会话?",
      session_empty: () => "暂无会话",
      session_group_earlier: () => "更早",
      session_group_month: () => "近 30 天",
      session_group_today: () => "今天",
      session_group_week: () => "近 7 天",
      session_group_yesterday: () => "昨天",
      session_rename: () => "重命名",
      session_unread: () => "未读",
      task_pending: () => "等待中",
      task_running: () => "执行中",
    },
  }),
}));

import { ChatHistoryPanel } from "../ChatHistoryPanel";

const session = (id: string, title: string): ChatSession => ({
  id,
  workspacePath: "/tmp/workspace",
  title,
  createdAt: "2026-06-12T02:00:00.000Z",
  updatedAt: "2026-06-12T02:00:00.000Z",
});

describe("ChatHistoryPanel", () => {
  beforeEach(() => {
    chatState.value = {
      sessions: [session("session-1", "支持多会话管理")],
      activeSessionId: "session-1",
      sessionRunStates: {},
      activeSessionRunState: null,
      selectedLlmConfigId: null,
      isLoading: false,
      setSelectedLlmConfigId: vi.fn(),
      handleNewChat: vi.fn(),
      handleSelectSession: vi.fn(),
      handleDeleteSession: vi.fn(),
      handleRenameSession: vi.fn(),
    };
  });

  it("renders a fixed row status indicator for pending sessions", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessionRunStates: {
        "session-1": {
          status: "pending",
          assistantMessageId: "assistant-1",
        },
      },
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-run-status="pending"');
    expect(html).toContain('aria-label="等待中"');
    expect(html).toContain("ml-auto");
    expect(html).toContain("shrink-0");
  });

  it("renders a running status indicator with the running label", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessionRunStates: {
        "session-1": {
          status: "running",
          taskId: "task-1",
          assistantMessageId: "assistant-1",
        },
      },
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-run-status="running"');
    expect(html).toContain('aria-label="执行中"');
  });

  it("renders an unread status indicator after a background session settles", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessionRunStates: {
        "session-1": {
          status: "unread",
          assistantMessageId: "assistant-1",
        },
      },
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-run-status="unread"');
    expect(html).toContain('aria-label="未读"');
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("animate-spin");
  });
});
