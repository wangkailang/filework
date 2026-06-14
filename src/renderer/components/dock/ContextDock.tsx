// 右侧统一停靠面板:预览 / Diff / Web 三标签共用一个容器,可拖分隔条调宽。
// 由父级(App)通过 mode 决定分栏(参与 flex 布局)还是浮层(absolute 覆盖)。
import { Maximize2, Minimize2, X } from "lucide-react";
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
import { SearchPanel } from "./SearchPanel";
import { TrashPanel } from "./TrashPanel";

export type DockTab =
  | "preview"
  | "diff"
  | "web"
  | "subagent"
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
  diffInvalidator,
  isGitRepo,
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
  diffInvalidator: number;
  /** 非 git 项目隐藏「差异」标签与内容(网页面板对所有工作区可用)。 */
  isGitRepo: boolean;
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

  const tabBtn = (t: DockTab, label: string) => (
    <button
      type="button"
      onClick={() => onTabChange(t)}
      className={`rounded-t-md px-3 py-1.5 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 ${
        effectiveTab === t
          ? "bg-card text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

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
      <div className="titlebar-no-drag flex h-9 items-center gap-1 border-b border-border px-2">
        {tabBtn("preview", LL.dock_preview())}
        {tabBtn("search", LL.dock_search())}
        {tabBtn("trash", LL.dock_trash())}
        {isGitRepo && tabBtn("diff", LL.dock_diff())}
        {tabBtn("web", LL.dock_web())}
        {subagentSel && tabBtn("subagent", LL.dock_subagent())}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setIsFullscreen((v) => !v)}
          className="rounded p-1 hover:bg-accent"
          aria-label={
            isFullscreen ? LL.preview_exitFullscreen() : LL.preview_fullscreen()
          }
          aria-pressed={isFullscreen}
          title={
            isFullscreen ? LL.preview_exitFullscreen() : LL.preview_fullscreen()
          }
        >
          {isFullscreen ? (
            <Minimize2 className="size-3.5 text-muted-foreground" />
          ) : (
            <Maximize2 className="size-3.5 text-muted-foreground" />
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-accent"
          aria-label={LL.session_close()}
        >
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      {/* 三个标签内容常驻挂载,仅用 CSS 隐藏非活动标签:切换标签不再卸载
          webview / 文件预览,保留页面、滚动、缩放等状态。 */}
      <div className="h-[calc(100%-2.25rem)] overflow-hidden">
        <div className={cn("h-full", effectiveTab !== "preview" && "hidden")}>
          {filePath ? (
            <FilePreviewPanel filePath={filePath} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {LL.session_empty()}
            </div>
          )}
        </div>
        {/* 搜索 / 回收站:对所有工作区可用,常驻挂载,仅 CSS 隐藏。 */}
        <div className={cn("h-full", effectiveTab !== "search" && "hidden")}>
          <SearchPanel
            workspaceRoot={workspaceRoot}
            active={effectiveTab === "search"}
          />
        </div>
        <div className={cn("h-full", effectiveTab !== "trash" && "hidden")}>
          <TrashPanel
            workspaceRoot={workspaceRoot}
            active={effectiveTab === "trash"}
          />
        </div>
        {/* 差异:仅 git 项目挂载(非 git 时标签与内容一并隐藏)。 */}
        {isGitRepo && (
          <div className={cn("h-full", effectiveTab !== "diff" && "hidden")}>
            <BranchDiffPanel
              workspaceRoot={workspaceRoot}
              currentBranch={currentBranch}
              invalidator={diffInvalidator}
            />
          </div>
        )}
        {/* 网页:对所有工作区常驻挂载。无 URL 时 BrowserPanel 自行展示
            起始页(地址栏可用);本地 HTML 预览经 local-file:// 加载。
            key 按 local / web 切换:本地预览与真实浏览用隔离 partition,
            scheme 变化时整组件重挂载,使 webview 以正确 partition 重建。 */}
        <div className={cn("h-full", effectiveTab !== "web" && "hidden")}>
          <BrowserPanel
            key={(url ?? "").startsWith("local-file://") ? "local" : "web"}
            url={url ?? ""}
          />
        </div>
        {/* subagent 钻入:仅在有选中项时挂载(数据来自 chat context,
            随子 agent 流式实时更新)。 */}
        {subagentSel && (
          <div
            className={cn("h-full", effectiveTab !== "subagent" && "hidden")}
          >
            <SubagentTracePanel
              batchId={subagentSel.batchId}
              childTaskId={subagentSel.childTaskId}
              onSelectChild={onSelectSubagentChild}
            />
          </div>
        )}
      </div>
    </aside>
  );
};
