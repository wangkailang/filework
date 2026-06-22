import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      session_branch_current: () => "当前分支",
      session_branch_hint: () =>
        "聊天分支反映上次使用时的活动分支；发送消息将更新聊天分支",
      session_rename: () => "重命名",
      session_unread: () => "未读",
      automations_title: () => "自动化",
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T08:00:00.000Z"));
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sorts sessions by recency before rendering groups", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessions: [
        {
          ...session("older", "旧会话"),
          updatedAt: "2026-06-13T02:00:00.000Z",
        },
        {
          ...session("newer", "新会话"),
          updatedAt: "2026-06-13T06:00:00.000Z",
        },
      ],
      activeSessionId: "newer",
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html.indexOf("新会话")).toBeLessThan(html.indexOf("旧会话"));
  });

  it("renders a compact Codex-style row with relative age on the right", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessions: [
        {
          ...session("session-1", "支持修改分镜 prompt"),
          updatedAt: "2026-06-13T04:00:00.000Z",
        },
      ],
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-row="session-1"');
    expect(html).toContain('data-session-age="4 小时"');
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]");
  });

  it("uses one trailing slot where hover hides time and shows actions", () => {
    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-row-meta="session-1"');
    expect(html).toContain('data-session-row-actions="session-1"');
    expect(html).toContain("group-hover:opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).not.toContain("w-11");
  });

  it("hides automation-backed sessions from the project chat list", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessions: [
        {
          ...session("regular-session", "普通项目对话"),
          updatedAt: "2026-06-13T07:00:00.000Z",
        },
        {
          ...session("automation-session", "新对话"),
          automationRun: {
            id: "run-1",
            automationId: "auto-1",
            title: "每日 Filework commit 改动统计",
          },
        } as ChatSession,
        {
          ...session(
            "legacy-automation-session",
            "Run automation now: 每日仓库巡检",
          ),
          automationRun: {
            id: "run-2",
            automationId: "auto-2",
            title: "每日仓库巡检",
          },
        } as ChatSession,
      ],
      activeSessionId: "automation-session",
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain("普通项目对话");
    expect(html).not.toContain('data-session-row="automation-session"');
    expect(html).not.toContain('data-session-row="legacy-automation-session"');
    expect(html).not.toContain("每日 Filework commit 改动统计");
    expect(html).not.toContain("每日仓库巡检");
    expect(html).not.toContain("Run automation now:");
    expect(html).not.toContain(">新对话<");
  });

  it("shows the empty state when a workspace only has automation chats", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessions: [
        {
          ...session("automation-session", "Run automation now: 每日仓库巡检"),
          automationRun: {
            id: "run-1",
            automationId: "auto-1",
            title: "每日仓库巡检",
          },
        } as ChatSession,
      ],
      activeSessionId: "automation-session",
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain("暂无会话");
    expect(html).not.toContain('data-session-row="automation-session"');
  });

  it("exposes current branch context in the session detail affordance", () => {
    const html = renderToStaticMarkup(
      <ChatHistoryPanel currentBranch="master" isGitRepo={true} />,
    );

    expect(html).toContain('data-session-branch="master"');
    expect(html).toContain("当前分支");
    expect(html).toContain(
      "聊天分支反映上次使用时的活动分支；发送消息将更新聊天分支",
    );
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
