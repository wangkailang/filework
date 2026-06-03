import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  Loader2,
  X,
} from "lucide-react";
import { useState } from "react";

import type { SubagentChildView, SubagentMessagePart } from "./types";

/** 终态(非 running)的子 agent 视为已完成。 */
const isDone = (s: SubagentChildView["status"]): boolean => s !== "running";

const STATUS_META: Record<
  SubagentChildView["status"],
  { label: string; className: string; Icon: typeof Check }
> = {
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
};

export function StatusBadge({
  status,
}: {
  status: SubagentChildView["status"];
}) {
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
        <StatusBadge status={child.status} />
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
  const anyFailed = children.some(
    (c) => c.status === "failed" || c.status === "timeout",
  );

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
        {allDone && anyFailed && (
          <span className="text-amber-500">· 含失败</span>
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
