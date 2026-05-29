// 右侧统一停靠面板:预览 / Diff / Web 三标签共用一个容器,可拖分隔条调宽。
// 由父级(App)通过 mode 决定分栏(参与 flex 布局)还是浮层(absolute 覆盖)。
import { X } from "lucide-react";
import { useCallback, useRef } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
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
}) => {
  const { LL } = useI18nContext();
  const widthRef = useRef(width);
  widthRef.current = width;

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
        activeTab === t
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
        mode === "overlay"
          ? "absolute top-0 right-0 z-40 h-full border-l border-border bg-background shadow-2xl"
          : "relative h-full shrink-0 border-l border-border bg-background"
      }
      style={{ width }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 竖向 resize 手柄用 div + ARIA 是分栏标准做法 */}
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
      <div className="flex h-9 items-center gap-1 border-b border-border px-2">
        {tabBtn("preview", LL.dock_preview())}
        {tabBtn("diff", LL.dock_diff())}
        {tabBtn("web", LL.dock_web())}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-accent"
          aria-label={LL.session_close()}
        >
          <X className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="h-[calc(100%-2.25rem)] overflow-hidden">
        {activeTab === "preview" &&
          (filePath ? (
            <FilePreviewPanel filePath={filePath} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {LL.session_empty()}
            </div>
          ))}
        {activeTab === "diff" && (
          <BranchDiffPanel
            workspaceRoot={workspaceRoot}
            currentBranch={currentBranch}
            invalidator={diffInvalidator}
          />
        )}
        {activeTab === "web" &&
          (url ? (
            <BrowserPanel url={url} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">—</div>
          ))}
      </div>
    </aside>
  );
};
