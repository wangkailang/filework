import { RefreshCw, X } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { BranchDiffFileCard } from "./BranchDiffFileCard";
import { useBranchDiff } from "./useBranchDiff";

interface BranchDiffPanelProps {
  /** Workspace root absolute path. Empty/undefined → empty state. */
  workspaceRoot?: string;
  /** Current checked-out branch. Threaded into the hook so a
   *  BranchSwitcher checkout invalidates the cache immediately. */
  currentBranch?: string | null;
  /** Close button. Parent owns the open state — when closed, parent
   *  simply unmounts this panel. */
  onClose: () => void;
  /** Bump to force a refetch from outside (eg after a tool finishes). */
  invalidator?: number;
}

const WIDTH_STORAGE_KEY = "filework.branchDiff.width";
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 320;

/**
 * Persistent right-side diff panel. Lives in the main flexbox row
 * alongside Sidebar / Chat — *not* a modal overlay — so the user can
 * keep chatting while inspecting the branch diff. Drag the 4 px wide
 * resizer on the left edge to change the panel width; the value is
 * persisted to localStorage so it survives reloads.
 */
export function BranchDiffPanel({
  workspaceRoot,
  currentBranch,
  onClose,
  invalidator,
}: BranchDiffPanelProps) {
  const { LL } = useI18nContext();
  const { data, loading, error, refresh } = useBranchDiff({
    path: workspaceRoot,
    currentBranch,
    invalidator,
  });

  const [width, setWidth] = useState<number>(() => readStoredWidth());
  const draggingRef = useRef(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const startResize = useCallback(() => {
    if (draggingRef.current) return;
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (e: MouseEvent) => {
      const next = clampWidth(window.innerWidth - e.clientX);
      setWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(widthRef.current));
      } catch {
        // ignore storage quota / disabled
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Clamp width on viewport resize so the panel never exceeds 80%.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const style: CSSProperties = {
    width: `${width}px`,
    flex: `0 0 ${width}px`,
  };

  return (
    <aside
      style={style}
      className="relative h-full bg-background border-l border-border flex flex-col"
    >
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
        aria-label="resize panel"
        role="separator"
      />
      <header className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">
            {data && data.headBranch
              ? LL.branch_diff_title(data.headBranch, data.baseBranch)
              : LL.branch_diff_open()}
          </div>
          {data && !data.notAvailable && (
            <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
              <span className="text-emerald-500">+{data.totalAdded}</span>{" "}
              <span className="text-red-400">-{data.totalRemoved}</span>
              <span className="ml-2 text-muted-foreground/70">
                {data.base === data.head
                  ? `@${data.base.slice(0, 7)}`
                  : `${data.base.slice(0, 7)}…${data.head.slice(0, 7)}`}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-50"
          title={LL.branch_diff_refresh()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          title="close"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {renderBody({ data, loading, error, LL })}
      </div>
    </aside>
  );
}

function clampWidth(raw: number): number {
  const max = Math.floor(window.innerWidth * 0.8);
  return Math.max(MIN_WIDTH, Math.min(max, raw));
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WIDTH;
    return clampWidth(n);
  } catch {
    return DEFAULT_WIDTH;
  }
}

interface BodyArgs {
  data: ReturnType<typeof useBranchDiff>["data"];
  loading: boolean;
  error: string | null;
  LL: ReturnType<typeof useI18nContext>["LL"];
}

function renderBody({ data, loading, error, LL }: BodyArgs): ReactNode {
  if (loading && !data) {
    return <div className="text-xs text-muted-foreground italic">…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-400">{error}</div>;
  }
  if (!data) {
    return null;
  }
  if (data.notAvailable === "not-git") {
    return (
      <div className="text-xs text-muted-foreground italic">
        {LL.branch_diff_not_git()}
      </div>
    );
  }
  if (data.notAvailable === "no-base") {
    return (
      <div className="text-xs text-muted-foreground italic">
        {LL.branch_diff_no_base()}
        {data.errorMessage && (
          <div className="mt-1 font-mono text-[10px] text-foreground/60">
            {data.errorMessage}
          </div>
        )}
      </div>
    );
  }
  if (data.notAvailable) {
    return (
      <div className="text-xs text-red-400">
        {LL.branch_diff_exec_failed()}
        {data.errorMessage && (
          <div className="mt-1 font-mono text-[10px] text-foreground/60">
            {data.errorMessage}
          </div>
        )}
      </div>
    );
  }
  if (data.files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        {LL.branch_diff_empty()}
      </div>
    );
  }
  return (
    <>
      {data.truncated && (
        <div className="text-xs text-amber-400 mb-1">
          {LL.preview_diff_truncated()}
        </div>
      )}
      {data.files.map((f) => (
        <BranchDiffFileCard key={`${f.status}-${f.path}`} file={f} LL={LL} />
      ))}
    </>
  );
}
