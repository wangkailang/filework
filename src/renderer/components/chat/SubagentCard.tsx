import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Coins,
  Hourglass,
  Loader2,
  X,
} from "lucide-react";
import { useState } from "react";

import type { SubagentChildView, SubagentMessagePart } from "./types";

/** 终态的子 agent 视为已完成；queued/running 都还在批次内。 */
const isDone = (s: SubagentChildView["status"]): boolean =>
  s !== "queued" && s !== "running";

export const isPartialSubagentResult = (child: SubagentChildView): boolean =>
  child.resultQuality === "usable_partial";

export const isUsableSubagentResult = (child: SubagentChildView): boolean =>
  child.resultQuality === "complete" ||
  (child.resultQuality === undefined && child.status === "ok");

const isTruncatedNoResult = (child: SubagentChildView): boolean =>
  child.resultQuality === "no_result" &&
  (child.status === "token_limit" || child.status === "timeout");

export type SubagentDisplayStatus =
  | SubagentChildView["status"]
  | "partial"
  | "truncated"
  | "no_result";

export const getSubagentDisplayStatus = (
  child: SubagentChildView,
): SubagentDisplayStatus =>
  isPartialSubagentResult(child)
    ? "partial"
    : isTruncatedNoResult(child)
      ? "truncated"
      : child.resultQuality === "no_result"
        ? "no_result"
        : child.status;

const STATUS_META: Record<
  SubagentDisplayStatus,
  { label: string; className: string; Icon: typeof Check }
> = {
  queued: {
    label: "排队中",
    className: "text-muted-foreground",
    Icon: Hourglass,
  },
  running: { label: "进行中", className: "text-blue-400", Icon: Loader2 },
  ok: { label: "完成", className: "text-emerald-500", Icon: Check },
  failed: { label: "失败", className: "text-red-400", Icon: X },
  cancelled: { label: "已取消", className: "text-muted-foreground", Icon: Ban },
  timeout: { label: "超时", className: "text-amber-500", Icon: Clock },
  token_limit: {
    label: "token 超限",
    className: "text-amber-500",
    Icon: Coins,
  },
  partial: {
    label: "部分结果",
    className: "text-amber-500",
    Icon: CircleAlert,
  },
  truncated: {
    label: "已截断",
    className: "text-amber-500",
    Icon: CircleAlert,
  },
  no_result: {
    label: "无有效结果",
    className: "text-amber-500",
    Icon: CircleAlert,
  },
};

export function StatusBadge({ status }: { status: SubagentDisplayStatus }) {
  const { label, className, Icon } = STATUS_META[status];
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-[10px] ${className}`}
    >
      <Icon
        className={`h-3 w-3 ${status === "running" ? "animate-spin" : ""}`}
      />
      {label}
    </span>
  );
}

function fmtTokens(n: number | null): string | null {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function ChildRow({
  batchId,
  child,
}: {
  batchId: string;
  child: SubagentChildView;
}) {
  const total = fmtTokens(child.usage.totalTokens);
  // 点击整行 → 在 ContextDock 钻入查看该子 agent 的执行过程(App 监听该事件)。
  const openTrace = () =>
    window.dispatchEvent(
      new CustomEvent("filework:open-subagent", {
        detail: { batchId, childTaskId: child.childTaskId },
      }),
    );
  return (
    <button
      type="button"
      onClick={openTrace}
      className="group flex w-full items-center gap-2 border-t border-border/60 px-3 py-1.5 text-left text-xs first:border-t-0 hover:bg-accent/40"
      title={`查看「${child.goal}」的执行过程`}
    >
      <span className="truncate text-foreground/80">{child.goal}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
        {child.stepCount > 0 && <span>{child.stepCount} 步</span>}
        {total && <span className="font-mono">{total} tok</span>}
        <StatusBadge status={getSubagentDisplayStatus(child)} />
        <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
    </button>
  );
}

export function SubagentCard({ part }: { part: SubagentMessagePart }) {
  const [expanded, setExpanded] = useState(true);
  const { children, concurrency } = part;
  const doneCount = children.filter((c) => isDone(c.status)).length;
  const allDone = doneCount === children.length;
  const effectiveCount = children.filter(isUsableSubagentResult).length;
  const partialCount = children.filter(isPartialSubagentResult).length;
  const truncatedCount = children.filter(isTruncatedNoResult).length;
  const failedCount = children.filter((c) => c.status === "failed").length;

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium hover:bg-accent/30"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {!allDone && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
        )}
        <span className="text-foreground/80">子任务委派</span>
        <span className="text-muted-foreground">
          · {children.length} 子任务 · 并发 {concurrency} · 完成 {doneCount}/
          {children.length}
        </span>
        {allDone && (
          <span className="text-muted-foreground">
            · 有效 {effectiveCount}/{children.length}
          </span>
        )}
        {allDone && partialCount > 0 && (
          <span className="text-amber-500">· 部分结果 {partialCount}</span>
        )}
        {allDone && truncatedCount > 0 && (
          <span className="text-amber-500">· 截断 {truncatedCount}</span>
        )}
        {allDone && failedCount > 0 && (
          <span className="text-amber-500">· 失败 {failedCount}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border">
          {children.map((c) => (
            <ChildRow key={c.childTaskId} batchId={part.batchId} child={c} />
          ))}
        </div>
      )}
    </div>
  );
}
