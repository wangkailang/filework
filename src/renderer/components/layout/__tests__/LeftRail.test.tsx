import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

  it("renders an automation launcher above chat history without adding another rail tab", () => {
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
});
