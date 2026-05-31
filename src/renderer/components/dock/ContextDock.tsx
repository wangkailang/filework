// 右侧统一停靠面板:预览 / Diff / Web 三标签共用一个容器,可拖分隔条调宽。
// 由父级(App)通过 mode 决定分栏(参与 flex 布局)还是浮层(absolute 覆盖)。
import { Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { BranchDiffPanel } from "../branch-diff/BranchDiffPanel";
import { BrowserPanel } from "../browser/BrowserPanel";
import { FilePreviewPanel } from "../file-preview/FilePreviewPanel";
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  type DockMode,
} from "../layout/layout-geometry";

export type DockTab = "preview" | "diff" | "web";

export const ContextDock = ({
  mode,
  width,
  activeTab,
  onTabChange,
  onClose,
  onWidthChange,
  onCommitWidth,
  filePath,
  url,
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
  filePath: string | null;
  url: string | null;
  workspaceRoot: string;
  currentBranch?: string | null;
  diffInvalidator: number;
  /** 非 git 项目隐藏「差异 / 网页」两个标签与内容。 */
  isGitRepo: boolean;
}) => {
  const { LL } = useI18nContext();
  const widthRef = useRef(width);
  widthRef.current = width;
  // 全屏:铺满窗口(fixed inset-0),忽略 width 与 mode。关闭面板时一并复位。
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 非 git 项目不提供「差异 / 网页」,即使 activeTab 残留也回落到预览。
  const effectiveTab: DockTab = isGitRepo ? activeTab : "preview";

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
      className={`rounded-t-md px-3 py-1.5 text-xs ${
        effectiveTab === t
          ? "bg-card text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <aside
      className={
        isFullscreen
          ? // 让开顶部 28px 系统标题栏(hiddenInset):否则头部按钮落在 OS 拖拽区里点不动。
            "fixed top-7 right-0 bottom-0 left-0 z-50 border-l border-border bg-background"
          : mode === "overlay"
            ? "absolute top-0 right-0 z-40 h-full border-l border-border bg-background shadow-2xl"
            : "relative h-full shrink-0 border-l border-border bg-background"
      }
      style={isFullscreen ? undefined : { width }}
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
        {isGitRepo && tabBtn("diff", LL.dock_diff())}
        {isGitRepo && tabBtn("web", LL.dock_web())}
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
        {/* 差异 / 网页:仅 git 项目挂载(非 git 时标签与内容一并隐藏)。 */}
        {isGitRepo && (
          <div className={cn("h-full", effectiveTab !== "diff" && "hidden")}>
            <BranchDiffPanel
              workspaceRoot={workspaceRoot}
              currentBranch={currentBranch}
              invalidator={diffInvalidator}
            />
          </div>
        )}
        {isGitRepo && (
          <div className={cn("h-full", effectiveTab !== "web" && "hidden")}>
            {url ? (
              <BrowserPanel url={url} />
            ) : (
              <div className="p-4 text-sm text-muted-foreground">—</div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
