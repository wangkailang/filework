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
      session_filter_all: () => "全部",
      session_filter_attention: () => "需关注",
      session_filter_duplicates: () => "重复",
      session_filter_empty: () => "空会话",
      session_filter_label: () => "筛选任务",
      session_group_earlier: () => "更早",
      session_group_attention: () => "需要关注",
      session_group_month: () => "近 30 天",
      session_group_today: () => "今天",
      session_group_week: () => "近 7 天",
      session_group_yesterday: () => "昨天",
      session_branch_current: () => "聊天分支",
      session_branch_hint: () =>
        "聊天分支反映上次使用时的活动分支；发送消息将更新聊天分支",
      session_rename: () => "重命名",
      session_actions: () => "更多操作",
      session_search: () => "搜索任务",
      session_searchEmpty: () => "没有匹配的任务",
      session_unread: () => "未读",
      automations_title: () => "自动化",
      task_pending: () => "等待中",
      task_running: () => "执行中",
    },
  }),
}));

import { ChatHistoryPanel, filterHistorySessions } from "../ChatHistoryPanel";

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

  it("moves running and unread tasks into an attention group above recency", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessions: [
        {
          ...session("recent-idle", "最近的普通任务"),
          updatedAt: "2026-06-13T07:00:00.000Z",
        },
        {
          ...session("older-running", "较早但执行中的任务"),
          updatedAt: "2026-06-01T07:00:00.000Z",
        },
      ],
      sessionRunStates: {
        "older-running": {
          status: "running",
          taskId: "task-1",
          assistantMessageId: "assistant-1",
        },
      },
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain(">需要关注<");
    expect(html.indexOf("需要关注")).toBeLessThan(html.indexOf("今天"));
    expect(html.indexOf("较早但执行中的任务")).toBeLessThan(
      html.indexOf("最近的普通任务"),
    );
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

  it("reduces each row to one keyboard-accessible action menu", () => {
    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-row-meta="session-1"');
    expect(html).toContain('data-session-row-actions="session-1"');
    expect(html).toContain('data-session-action-menu="session-1"');
    expect(html).toContain('aria-label="更多操作"');
    expect(html).toContain("group-hover:opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-focus-within:opacity-0");
    expect(html).toContain("group-focus-within:opacity-100");
  });

  it("provides a searchable task history control", () => {
    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('data-session-search="true"');
    expect(html).toContain('type="search"');
    expect(html).toContain('placeholder="搜索任务"');
  });

  it("exposes governance filters for attention, duplicate, and empty tasks", () => {
    const html = renderToStaticMarkup(<ChatHistoryPanel />);

    expect(html).toContain('aria-label="筛选任务"');
    expect(html).toContain('data-session-filter="all"');
    expect(html).toContain('data-session-filter="attention"');
    expect(html).toContain('data-session-filter="duplicates"');
    expect(html).toContain('data-session-filter="empty"');
    expect(html).toContain(">需关注<");
    expect(html).toContain(">重复<");
    expect(html).toContain(">空会话<");
  });

  it("identifies attention, duplicate, and untitled sessions without mutating history", () => {
    const sessions = [
      session("attention", "等待确认"),
      session("duplicate-a", "修复登录问题"),
      session("duplicate-b", "  修复登录问题  "),
      session("empty", "新对话"),
      session("normal", "梳理发布流程"),
    ];
    const runStates = {
      attention: {
        status: "running" as const,
        taskId: "task-1",
      },
    };

    expect(
      filterHistorySessions(sessions, "attention", runStates, "zh-CN").map(
        (item) => item.id,
      ),
    ).toEqual(["attention"]);
    expect(
      filterHistorySessions(sessions, "duplicates", runStates, "zh-CN").map(
        (item) => item.id,
      ),
    ).toEqual(["duplicate-a", "duplicate-b"]);
    expect(
      filterHistorySessions(sessions, "empty", runStates, "zh-CN").map(
        (item) => item.id,
      ),
    ).toEqual(["empty"]);
    expect(sessions).toHaveLength(5);
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

  it("exposes the session branch in the session detail affordance", () => {
    chatState.value = {
      ...(chatState.value as Record<string, unknown>),
      sessions: [
        {
          ...session("session-1", "支持多会话管理"),
          lastActiveBranch: "feature/session-branch",
        } as ChatSession,
      ],
    };

    const html = renderToStaticMarkup(<ChatHistoryPanel isGitRepo={true} />);

    expect(html).toContain('data-session-branch="feature/session-branch"');
    expect(html).not.toContain('data-session-branch="master"');
    expect(html).toContain("聊天分支");
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
