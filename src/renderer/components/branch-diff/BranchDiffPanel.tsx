import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
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
  /** Bump to force a refetch from outside (eg after a tool finishes). */
  invalidator?: number;
}

/**
 * 分支 diff 内容,宿主于 ContextDock 的「Diff」标签。宽度与关闭由 Dock
 * 统一控制,这里只填满父容器并渲染标题摘要 + 文件卡片。
 */
export function BranchDiffPanel({
  workspaceRoot,
  currentBranch,
  invalidator,
}: BranchDiffPanelProps) {
  const { LL } = useI18nContext();
  const { data, loading, error, refresh } = useBranchDiff({
    path: workspaceRoot,
    currentBranch,
    invalidator,
  });

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {data?.headBranch
              ? LL.branch_diff_title(
                  data.headBranch,
                  data.baseRef ?? data.baseBranch,
                )
              : LL.branch_diff_open()}
          </div>
          {data && !data.notAvailable && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span>
                <span className="text-emerald-500">+{data.totalAdded}</span>{" "}
                <span className="text-red-400">-{data.totalRemoved}</span>
              </span>
              <span className="text-muted-foreground/70">
                {data.base === data.head
                  ? `@${data.base.slice(0, 7)}`
                  : `${data.base.slice(0, 7)}…${data.head.slice(0, 7)}`}
              </span>
              <StatusBadges data={data} LL={LL} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          title={LL.branch_diff_refresh()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </header>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
        {renderBody({ data, loading, error, LL })}
      </div>
    </div>
  );
}

interface StatusBadgesProps {
  data: NonNullable<ReturnType<typeof useBranchDiff>["data"]>;
  LL: ReturnType<typeof useI18nContext>["LL"];
}

function StatusBadges({ data, LL }: StatusBadgesProps) {
  const items: ReactNode[] = [];
  if (data.uncommitted !== undefined && data.uncommitted > 0) {
    items.push(
      <span
        key="uncommitted"
        className="px-1.5 rounded bg-amber-500/15 text-amber-400 normal-case"
      >
        {LL.branch_diff_uncommitted(data.uncommitted)}
      </span>,
    );
  }
  if (data.ahead !== undefined && data.ahead > 0) {
    items.push(
      <span
        key="ahead"
        className="px-1.5 rounded bg-emerald-500/15 text-emerald-400 normal-case"
      >
        {LL.branch_diff_ahead(data.ahead)}
      </span>,
    );
  }
  if (data.behind !== undefined && data.behind > 0) {
    items.push(
      <span
        key="behind"
        className="px-1.5 rounded bg-red-500/15 text-red-400 normal-case"
      >
        {LL.branch_diff_behind(data.behind)}
      </span>,
    );
  }
  return items.length > 0 ? items : null;
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
