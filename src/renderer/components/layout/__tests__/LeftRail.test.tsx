import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../chat/types";

const chatState = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  activeSessionId: null as string | null,
}));

vi.mock("../ChatHistoryPanel", () => ({
  ChatHistoryPanel: () => <div data-chat-history-panel="true" />,
}));

vi.mock("../FileTreePanel", () => ({
  FileTreePanel: () => <div data-file-tree-panel="true" />,
}));

vi.mock("../../skills/SkillsModal", () => ({
  SkillsModal: () => null,
}));

vi.mock("../../branch-diff/useBranchDiff", () => ({
  useBranchDiff: () => ({ data: null }),
}));

vi.mock("../../chat/ChatSessionProvider", () => ({
  useChatSessionLite: () => ({
    sessions: chatState.sessions,
    activeSessionId: chatState.activeSessionId,
    handleNewChat: vi.fn(),
  }),
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      branch_diff_open: () => "Open branch diff",
      automations_title: () => "Automations",
      rail_chats: () => "Chats",
      rail_files: () => "Files",
      session_close: () => "Close",
      session_newChat: () => "New chat",
      sidebar_closeDir: () => "Close workspace",
      sidebar_collapse: () => "Collapse",
      sidebar_expand: () => "Expand",
      sidebar_skills: () => "Skills",
      toast_branchSwitched: ({ branch }: { branch: string }) =>
        `Switched to ${branch}`,
      topbar_settings: () => "Settings",
    },
  }),
}));

import { LeftRail } from "../LeftRail";

describe("LeftRail", () => {
  beforeEach(() => {
    chatState.sessions = [];
    chatState.activeSessionId = null;
  });

  it("does not clip the branch switcher dropdown from the meta row", () => {
    const html = renderToStaticMarkup(
      <LeftRail
        workspacePath="/tmp/repo"
        workspaceRef={{ kind: "local", path: "/tmp/repo" }}
        currentBranch="main"
        isGitRepo={true}
        branchForChip="main"
        diffInvalidator={0}
        diffOpen={false}
        railTab="chats"
        onRailTabChange={vi.fn()}
        onSelectFile={vi.fn()}
        width={256}
        collapsed={false}
        onWidthChange={vi.fn()}
        onCommitWidth={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleDiff={vi.fn()}
        onBranchSwitched={vi.fn()}
        onCloseWorkspace={vi.fn()}
        automationsOpen={false}
        onOpenAutomations={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(html).toContain("Current branch: main");
    expect(html).not.toContain("items-center gap-1.5 overflow-hidden pl-6");
  });

  it("renders the global automations launcher above project chats", () => {
    const html = renderToStaticMarkup(
      <LeftRail
        workspacePath="/tmp/repo"
        workspaceRef={{ kind: "local", path: "/tmp/repo" }}
        currentBranch="main"
        isGitRepo={true}
        branchForChip="main"
        diffInvalidator={0}
        diffOpen={false}
        railTab="chats"
        onRailTabChange={vi.fn()}
        onSelectFile={vi.fn()}
        width={256}
        collapsed={false}
        onWidthChange={vi.fn()}
        onCommitWidth={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleDiff={vi.fn()}
        onBranchSwitched={vi.fn()}
        onCloseWorkspace={vi.fn()}
        automationsOpen={false}
        onOpenAutomations={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const automationsIndex = html.indexOf('data-automation-launcher="true"');
    const chatsIndex = html.indexOf('data-chat-history-panel="true"');

    expect(automationsIndex).toBeGreaterThanOrEqual(0);
    expect(chatsIndex).toBeGreaterThan(automationsIndex);
    expect(html).toContain(">Chats<");
    expect(html).toContain(">Files<");
    expect(html).toContain(">Automations<");
    expect(html).not.toContain("data-automations-panel");
  });

  it("highlights the automation launcher when viewing an automation chat", () => {
    chatState.sessions = [
      {
        id: "automation-session",
        workspacePath: "/tmp/repo",
        title: "Run automation now: 每日巡检",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
        automationRun: {
          id: "run-1",
          automationId: "auto-1",
          title: "每日巡检",
        },
      },
    ];
    chatState.activeSessionId = "automation-session";

    const html = renderToStaticMarkup(
      <LeftRail
        workspacePath="/tmp/repo"
        workspaceRef={{ kind: "local", path: "/tmp/repo" }}
        currentBranch="main"
        isGitRepo={true}
        branchForChip="main"
        diffInvalidator={0}
        diffOpen={false}
        railTab="chats"
        onRailTabChange={vi.fn()}
        onSelectFile={vi.fn()}
        width={256}
        collapsed={false}
        onWidthChange={vi.fn()}
        onCommitWidth={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleDiff={vi.fn()}
        onBranchSwitched={vi.fn()}
        onCloseWorkspace={vi.fn()}
        automationsOpen={false}
        onOpenAutomations={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(html).toContain('data-automation-launcher="true"');
    expect(html).toContain('aria-pressed="true"');
  });
});
