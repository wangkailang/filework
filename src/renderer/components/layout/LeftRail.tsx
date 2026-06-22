// 左栏:顶部 workspace 标识 + 分支 + diff 开关;中部 [对话 | 文件] 分段切换
// 会话列表 / 文件树;左下角 ⚙ 菜单(设置 / 技能,点击展开)。无独立顶栏。
// 复用原 Sidebar 的可拖宽 / 可折叠逻辑(宽度 clamp 走 layout-geometry)。
import {
  Blocks,
  CalendarClock,
  FolderOpen,
  GitCompareArrows,
  Github,
  Gitlab,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import {
  type WorkspaceRef,
  workspaceRefLabel,
} from "../../types/workspace-ref";
import { useBranchDiff } from "../branch-diff/useBranchDiff";
import { useChatSessionLite } from "../chat/ChatSessionProvider";
import { SkillsModal } from "../skills/SkillsModal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BranchSwitcher } from "./BranchSwitcher";
import { ChatHistoryPanel } from "./ChatHistoryPanel";
import { FileTreePanel } from "./FileTreePanel";
import {
  clampRailWidth,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  resolveRailMetaLayout,
} from "./layout-geometry";

export type RailTab = "chats" | "files";

const AUTOMATION_TITLE_PREFIXES = [
  /^Run automation now:\s*/i,
  /^现在执行自动化[：:]\s*/,
  /^执行自动化[：:]\s*/,
];

const isAutomationSession = (session: {
  automationRun?: unknown;
  title: string;
}): boolean => {
  if (session.automationRun) return true;
  return AUTOMATION_TITLE_PREFIXES.some((prefix) => prefix.test(session.title));
};

export const LeftRail = ({
  workspacePath,
  workspaceRef,
  currentBranch,
  isGitRepo,
  branchForChip,
  diffInvalidator,
  diffOpen,
  railTab,
  onRailTabChange,
  onSelectFile,
  width,
  collapsed,
  onWidthChange,
  onCommitWidth,
  onToggleCollapsed,
  onToggleDiff,
  onBranchSwitched,
  onCloseWorkspace,
  automationsOpen,
  onOpenAutomations,
  onOpenSettings,
}: {
  workspacePath: string;
  workspaceRef?: WorkspaceRef;
  currentBranch?: string | null;
  /** 非 git 项目不展示 diff 入口,并跳过分支 diff 探测。 */
  isGitRepo: boolean;
  branchForChip: string | null;
  diffInvalidator: number;
  diffOpen: boolean;
  railTab: RailTab;
  onRailTabChange: (t: RailTab) => void;
  onSelectFile: (path: string) => void;
  width: number;
  collapsed: boolean;
  onWidthChange: (width: number) => void;
  onCommitWidth: (width: number) => void;
  onToggleCollapsed: () => void;
  onToggleDiff?: () => void;
  onBranchSwitched?: (b: string) => void;
  onCloseWorkspace: () => void;
  automationsOpen: boolean;
  onOpenAutomations: () => void;
  onOpenSettings: () => void;
}) => {
  const { LL } = useI18nContext();
  const chat = useChatSessionLite();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // 分支 diff 摘要(用于 diff 开关上的 +/- 徽标)。便宜:hook 有缓存,
  // currentBranch 变化会 bust 缓存。
  const { data: diffSummary } = useBranchDiff({
    // 非 git 项目:path 传空,hook 在 fetchNow 处直接短路,不发起 git diff 探测。
    path: isGitRepo ? workspacePath : undefined,
    currentBranch,
    invalidator: diffInvalidator,
  });

  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        onWidthChange(clampRailWidth(startWidth + (ev.clientX - startX)));
      };
      const onUp = () => {
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        onCommitWidth(widthRef.current);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [onWidthChange, onCommitWidth],
  );

  const handleResizeKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = e.shiftKey ? 20 : 5;
      const delta = e.key === "ArrowLeft" ? -step : step;
      const next = clampRailWidth(widthRef.current + delta);
      onWidthChange(next);
      onCommitWidth(next);
    },
    [onWidthChange, onCommitWidth],
  );

  if (collapsed) return null;

  const dirName = workspaceRef
    ? workspaceRefLabel(workspaceRef)
    : workspacePath.split("/").pop() || workspacePath;
  const HeaderIcon =
    workspaceRef?.kind === "github"
      ? Github
      : workspaceRef?.kind === "gitlab"
        ? Gitlab
        : FolderOpen;
  const kindBadge =
    workspaceRef?.kind === "github"
      ? "GitHub"
      : workspaceRef?.kind === "gitlab"
        ? "GitLab"
        : "Local";
  const hasDiff =
    diffSummary &&
    !diffSummary.notAvailable &&
    (diffSummary.totalAdded > 0 || diffSummary.totalRemoved > 0);
  // 仅 git 项目展示 diff 入口(非 git 时分支 chip 本就因无分支名隐藏,这里再兜一层)。
  const diffButtonVisible = isGitRepo;
  const railMetaLayout = resolveRailMetaLayout(width);
  const activeSession = chat.sessions.find(
    (s) => s.id === chat.activeSessionId,
  );
  const automationActive =
    automationsOpen ||
    (activeSession ? isAutomationSession(activeSession) : false);

  const segBtn = (tab: RailTab, label: string) => (
    <button
      type="button"
      onClick={() => onRailTabChange(tab)}
      className={cn(
        "relative flex-1 py-1.5 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
        railTab === tab
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {railTab === tab && (
        <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)] animate-in fade-in-0 duration-200" />
      )}
    </button>
  );

  return (
    <>
      <aside
        className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface"
        style={{ width }}
      >
        {/* workspace 头部:名称(点击在 Finder 显示)+ 关闭 + 分支 + diff */}
        <div className="flex flex-col gap-1 border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              onClick={() => window.filework.showInFinder(workspacePath)}
              className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
              title={workspacePath}
            >
              <HeaderIcon className="size-4 shrink-0 text-file-folder" />
              <span className="truncate">{dirName}</span>
            </button>
            <button
              type="button"
              onClick={onCloseWorkspace}
              className="rounded p-1 transition-colors hover:bg-accent"
              title={LL.sidebar_closeDir()}
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </div>
          {workspaceRef && branchForChip && (
            <div className="flex min-w-0 items-center gap-1.5 pl-6">
              <BranchSwitcher
                workspaceRef={workspaceRef}
                currentBranch={branchForChip}
                onSwitched={(b) => onBranchSwitched?.(b)}
                className="min-w-0 flex-1"
                buttonClassName="w-full justify-start"
              />
              {diffButtonVisible && onToggleDiff && (
                <button
                  type="button"
                  onClick={onToggleDiff}
                  title={LL.branch_diff_open()}
                  className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground ${
                    diffOpen
                      ? "border-primary/50 bg-accent/50 text-foreground"
                      : "border-border/60 text-muted-foreground"
                  }`}
                >
                  <GitCompareArrows className="size-3" />
                  {hasDiff && diffSummary && (
                    <span className="font-mono">
                      <span className="text-status-success">
                        +{diffSummary.totalAdded}
                      </span>{" "}
                      <span className="text-status-error">
                        -{diffSummary.totalRemoved}
                      </span>
                    </span>
                  )}
                </button>
              )}
              {railMetaLayout.showKindBadge && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground/70 uppercase">
                  {kindBadge}
                </span>
              )}
            </div>
          )}
        </div>

        {/* [对话 | 文件] 分段 */}
        <div className="m-2 flex items-center gap-2">
          <div className="flex flex-1 border-b border-border">
            {segBtn("chats", LL.rail_chats())}
            {segBtn("files", LL.rail_files())}
          </div>
          <button
            type="button"
            onClick={chat.handleNewChat}
            className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95"
            title={LL.session_newChat()}
          >
            <MessageSquarePlus className="size-4" />
          </button>
        </div>

        {/* 两个面板常驻挂载,CSS 隐藏非活动者:切换 [对话|文件] 不再丢失
            文件树的展开/选中状态。FileTreePanel 以分支为 key,切换分支时
            重挂载并重新列目录(取代旧 Sidebar 在 onSwitched 里的 refresh)。 */}
        <div className="min-h-0 flex-1">
          <div className={cn("h-full", railTab !== "chats" && "hidden")}>
            <div className="flex h-full flex-col">
              <div className="border-b border-border px-2 pb-2">
                <button
                  type="button"
                  data-automation-launcher="true"
                  aria-pressed={automationActive}
                  onClick={onOpenAutomations}
                  title={LL.automations_title()}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    automationActive
                      ? "bg-accent text-foreground shadow-[inset_2px_0_0_var(--color-primary)]"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <CalendarClock
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{LL.automations_title()}</span>
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ChatHistoryPanel
                  currentBranch={branchForChip}
                  isGitRepo={isGitRepo}
                />
              </div>
            </div>
          </div>
          <div className={cn("h-full", railTab !== "files" && "hidden")}>
            <FileTreePanel
              key={`${workspacePath}:${branchForChip ?? ""}`}
              workspacePath={workspacePath}
              onSelectFile={onSelectFile}
            />
          </div>
        </div>

        {/* 左下角 ⚙ 菜单(设置 / 技能)+ 折叠 */}
        <div className="relative flex items-center justify-between border-t border-border px-2 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={LL.topbar_settings()}
              >
                <Menu className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-40">
              <DropdownMenuItem onClick={onOpenSettings}>
                <Settings className="size-4" />
                {LL.topbar_settings()}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSkillsOpen(true)}>
                <Blocks className="size-4" />
                {LL.sidebar_skills()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="rounded p-1 transition-colors hover:bg-accent"
            title={LL.sidebar_collapse()}
          >
            <PanelLeftClose className="size-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* biome-ignore lint/a11y/useSemanticElements: 竖向 resize 手柄用 div + ARIA 是分栏标准做法 */}
        <div
          onMouseDown={startResize}
          onKeyDown={handleResizeKey}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={RAIL_MIN_WIDTH}
          aria-valuemax={RAIL_MAX_WIDTH}
          tabIndex={0}
          className="absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30 focus:bg-primary/40 focus:outline-none active:bg-primary/50"
        />
      </aside>

      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} />
    </>
  );
};

/** 折叠态下由 App 渲染的浮动展开按钮(无顶栏,放在左上、让开红绿灯)。 */
export const RailExpandButton = ({ onClick }: { onClick: () => void }) => {
  const { LL } = useI18nContext();
  return (
    <button
      type="button"
      onClick={onClick}
      title={LL.sidebar_expand()}
      className="titlebar-no-drag absolute left-2 top-1 z-[60] flex h-[34px] items-center rounded-md px-1.5 transition-all hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95"
    >
      <PanelLeftOpen className="size-4 text-muted-foreground" />
    </button>
  );
};
