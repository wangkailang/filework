// 右侧统一停靠面板:预览 / 搜索 / 回收站 / Diff / Web / 子 agent 共用一个容器,可拖分隔条调宽。
// 由父级(App)通过 mode 决定分栏(参与 flex 布局)还是浮层(absolute 覆盖)。
import {
  Bot,
  CalendarClock,
  FileText,
  GitCompareArrows,
  Globe,
  type LucideIcon,
  Maximize2,
  Minimize2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { BranchDiffPanel } from "../branch-diff/BranchDiffPanel";
import { BrowserPanel } from "../browser/BrowserPanel";
import { SubagentTracePanel } from "../chat/SubagentTracePanel";
import { FilePreviewPanel } from "../file-preview/FilePreviewPanel";
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  type DockMode,
  resolveFullscreenDockLeft,
  resolveFullscreenDockTop,
} from "../layout/layout-geometry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AutomationsDockPanel } from "./AutomationsDockPanel";
import { SearchPanel } from "./SearchPanel";
import { TrashPanel } from "./TrashPanel";

export type DockTab =
  | "preview"
  | "diff"
  | "web"
  | "subagent"
  | "automations"
  | "search"
  | "trash";

export const ContextDock = ({
  mode,
  width,
  activeTab,
  onTabChange,
  onClose,
  onWidthChange,
  onCommitWidth,
  railWidth,
  railCollapsed,
  filePath,
  url,
  subagentSel,
  onSelectSubagentChild,
  workspaceRoot,
  currentBranch,
  diffBaseBranch,
  onDiffBaseBranchChange,
  diffInvalidator,
  isGitRepo,
  automationInitialView = "tasks",
  onAutomationRunDetailsOpenedAsChat,
  automationViewRevision = 0,
}: {
  mode: DockMode;
  width: number;
  activeTab: DockTab;
  onTabChange: (t: DockTab) => void;
  onClose: () => void;
  onWidthChange: (w: number) => void;
  onCommitWidth: (w: number) => void;
  railWidth: number;
  railCollapsed: boolean;
  filePath: string | null;
  url: string | null;
  /** 钻入面板:当前查看的子 agent(批次 + 子任务)。null → 不显示 subagent 标签。 */
  subagentSel?: { batchId: string; childTaskId: string } | null;
  /** 兄弟 chip 切换某个子任务时回调。 */
  onSelectSubagentChild?: (childTaskId: string) => void;
  workspaceRoot: string;
  currentBranch?: string | null;
  diffBaseBranch?: string | null;
  onDiffBaseBranchChange?: (branch: string) => void;
  diffInvalidator: number;
  /** 非 git 项目隐藏「差异」标签与内容(网页面板对所有工作区可用)。 */
  isGitRepo: boolean;
  automationInitialView?: "tasks" | "triage";
  onAutomationRunDetailsOpenedAsChat?: () => void;
  automationViewRevision?: number;
}) => {
  const { LL } = useI18nContext();
  const widthRef = useRef(width);
  widthRef.current = width;
  // 全屏:铺满窗口(fixed inset-0),忽略 width 与 mode。关闭面板时一并复位。
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 预览 / 搜索 / 回收站 / 网页对所有工作区可用;「差异」仅 git 项目;
  // subagent 标签需有选中项才有效。任一不满足时回落到预览。
  const effectiveTab: DockTab =
    activeTab === "subagent"
      ? subagentSel
        ? "subagent"
        : "preview"
      : activeTab === "diff"
        ? isGitRepo
          ? activeTab
          : "preview"
        : activeTab;

  // 左边缘拖拽:向左拖变宽(dock 在右侧,故 delta 取负)。
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
        const next = Math.min(
          DOCK_MAX_WIDTH,
          Math.max(DOCK_MIN_WIDTH, startWidth - (ev.clientX - startX)),
        );
        onWidthChange(next);
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

  const tabTrigger = (t: DockTab, label: string, Icon: LucideIcon) => {
    return (
      <TabsTrigger
        value={t}
        data-dock-tab={t}
        aria-current={effectiveTab === t ? "page" : undefined}
        className={cn(
          "h-8 min-w-max flex-none rounded-2xl border border-transparent px-3.5 text-[13px] font-medium text-muted-foreground shadow-none transition-[color,background-color,box-shadow,border-color] hover:bg-background/55 hover:text-foreground data-[state=active]:border-border/80 data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-[0_1px_2px_rgba(15,23,42,0.08)]",
        )}
      >
        <Icon
          data-icon="inline-start"
          data-dock-tab-icon={t}
          className="size-4 shrink-0 text-current"
        />
        <span className="truncate">{label}</span>
      </TabsTrigger>
    );
  };

  return (
    // 打开时从右滑入 + 淡入,统一 200ms 节奏;fullscreen 覆盖到窗口顶部。
    <aside
      className={cn(
        "animate-in fade-in-0 slide-in-from-right-2 duration-200",
        isFullscreen
          ? "fixed right-0 bottom-0 z-50 border-l border-border bg-surface"
          : mode === "overlay"
            ? "absolute top-0 right-0 z-40 h-full border-l border-border bg-surface shadow-2xl"
            : "relative h-full shrink-0 border-l border-border bg-surface",
      )}
      style={
        isFullscreen
          ? {
              top: resolveFullscreenDockTop(),
              left: resolveFullscreenDockLeft({
                railWidth,
                railCollapsed,
              }),
            }
          : { width }
      }
    >
      {/* 全屏铺满窗口时调宽无意义,隐藏分隔条。 */}
      {!isFullscreen && (
        // biome-ignore lint/a11y/useSemanticElements: 竖向 resize 手柄用 div + ARIA 是分栏标准做法
        <div
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={DOCK_MIN_WIDTH}
          aria-valuemax={DOCK_MAX_WIDTH}
          tabIndex={0}
          className="absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30 focus:bg-primary/40 focus:outline-none"
        />
      )}
      <Tabs
        value={effectiveTab}
        onValueChange={(value) => onTabChange(value as DockTab)}
        className="h-full gap-0!"
      >
        <div className="titlebar-no-drag flex h-10 items-center gap-1 border-b border-border bg-muted/20 px-2">
          <TabsList
            aria-label={LL.dock_menu()}
            className="h-full min-w-0 flex-1 justify-start gap-1 overflow-x-auto rounded-none bg-transparent px-0 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabTrigger("preview", LL.dock_preview(), FileText)}
            {tabTrigger("search", LL.dock_search(), Search)}
            {tabTrigger("trash", LL.dock_trash(), Trash2)}
            {tabTrigger("automations", LL.automations_title(), CalendarClock)}
            {isGitRepo && tabTrigger("diff", LL.dock_diff(), GitCompareArrows)}
            {tabTrigger("web", LL.dock_web(), Globe)}
            {subagentSel && tabTrigger("subagent", LL.dock_subagent(), Bot)}
          </TabsList>
          <button
            type="button"
            onClick={() => setIsFullscreen((v) => !v)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={
              isFullscreen
                ? LL.preview_exitFullscreen()
                : LL.preview_fullscreen()
            }
            aria-pressed={isFullscreen}
            title={
              isFullscreen
                ? LL.preview_exitFullscreen()
                : LL.preview_fullscreen()
            }
          >
            {isFullscreen ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={LL.session_close()}
          >
            <X className="size-3.5" />
          </button>
        </div>
        {/* 各标签内容常驻挂载,仅用 CSS 隐藏非活动标签:切换标签不再卸载
            webview / 文件预览,保留页面、滚动、缩放等状态。 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <TabsContent
            forceMount
            value="preview"
            className="h-full data-[state=inactive]:hidden"
          >
            {filePath ? (
              <FilePreviewPanel filePath={filePath} />
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                {LL.session_empty()}
              </div>
            )}
          </TabsContent>
          {/* 搜索 / 回收站:对所有工作区可用,常驻挂载,仅 CSS 隐藏。 */}
          <TabsContent
            forceMount
            value="search"
            className="h-full data-[state=inactive]:hidden"
          >
            <SearchPanel
              workspaceRoot={workspaceRoot}
              active={effectiveTab === "search"}
            />
          </TabsContent>
          <TabsContent
            forceMount
            value="trash"
            className="h-full data-[state=inactive]:hidden"
          >
            <TrashPanel
              workspaceRoot={workspaceRoot}
              active={effectiveTab === "trash"}
            />
          </TabsContent>
          <TabsContent
            forceMount
            value="automations"
            className="h-full data-[state=inactive]:hidden"
          >
            <AutomationsDockPanel
              initialView={automationInitialView}
              onOpenChatDetails={onAutomationRunDetailsOpenedAsChat}
              viewRevision={automationViewRevision}
            />
          </TabsContent>
          {/* 差异:仅 git 项目挂载(非 git 时标签与内容一并隐藏)。 */}
          {isGitRepo && (
            <TabsContent
              forceMount
              value="diff"
              className="h-full data-[state=inactive]:hidden"
            >
              <BranchDiffPanel
                workspaceRoot={workspaceRoot}
                currentBranch={currentBranch}
                baseBranch={diffBaseBranch}
                onBaseBranchChange={onDiffBaseBranchChange}
                invalidator={diffInvalidator}
              />
            </TabsContent>
          )}
          {/* 网页:对所有工作区常驻挂载。无 URL 时 BrowserPanel 自行展示
              起始页(地址栏可用);本地 HTML 预览经 local-file:// 加载。
              key 按 local / web 切换:本地预览与真实浏览用隔离 partition,
              scheme 变化时整组件重挂载,使 webview 以正确 partition 重建。 */}
          <TabsContent
            forceMount
            value="web"
            className="h-full data-[state=inactive]:hidden"
          >
            <BrowserPanel
              key={(url ?? "").startsWith("local-file://") ? "local" : "web"}
              url={url ?? ""}
            />
          </TabsContent>
          {/* subagent 钻入:仅在有选中项时挂载(数据来自 chat context,
              随子 agent 流式实时更新)。 */}
          {subagentSel && (
            <TabsContent
              forceMount
              value="subagent"
              className="h-full data-[state=inactive]:hidden"
            >
              <SubagentTracePanel
                batchId={subagentSel.batchId}
                childTaskId={subagentSel.childTaskId}
                onSelectChild={onSelectSubagentChild}
              />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </aside>
  );
};
