import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import type {
  ApprovalState,
  BatchApprovalEntry,
} from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { PreviewEntryRow } from "./preview";
import { getToolLabels } from "./tool-labels";

// ---------------------------------------------------------------------------
// Types — re-exported from the shared core types so the JSONL session store
// and the renderer agree on a single source of truth.
// ---------------------------------------------------------------------------

export type { ApprovalState } from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface ConfirmationProps extends HTMLAttributes<HTMLDivElement> {
  state: ApprovalState;
}

export const Confirmation = ({
  state,
  children,
  className,
  ...props
}: ConfirmationProps) => (
  <div
    data-state={state}
    className={cn(
      "rounded-lg border text-sm",
      state === "approval-requested" && "border-amber-500/40 bg-amber-500/5",
      state === "approval-accepted" && "border-green-500/40 bg-green-500/5",
      state === "approval-rejected" && "border-red-500/40 bg-red-500/5",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Request (shown while waiting for user decision)
// ---------------------------------------------------------------------------

export const ConfirmationRequest = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-start gap-2 px-3 py-2.5", className)}
    {...props}
  >
    <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
    <div className="text-foreground/90 text-xs leading-relaxed">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------
// Accepted
// ---------------------------------------------------------------------------

export const ConfirmationAccepted = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2", className)}
    {...props}
  >
    <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
    <span className="text-xs text-green-400">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Rejected
// ---------------------------------------------------------------------------

export const ConfirmationRejected = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2", className)}
    {...props}
  >
    <XCircle className="size-3.5 text-red-500 shrink-0" />
    <span className="text-xs text-red-400">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Actions (approve / reject buttons)
// ---------------------------------------------------------------------------

export const ConfirmationActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 pb-2.5", className)}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Action button
// ---------------------------------------------------------------------------

interface ConfirmationActionProps extends HTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
}

export const ConfirmationAction = ({
  variant = "default",
  disabled,
  children,
  className,
  ...props
}: ConfirmationActionProps) => (
  <button
    type="button"
    disabled={disabled}
    className={cn(
      "inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "disabled:pointer-events-none disabled:opacity-50",
      variant === "default" &&
        "bg-primary text-primary-foreground hover:bg-primary/90",
      variant === "outline" &&
        "border border-border bg-transparent hover:bg-accent hover:text-foreground",
      variant === "destructive" &&
        "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      className,
    )}
    {...props}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Batch — one card for N destructive calls coalesced by approval-batcher
// ---------------------------------------------------------------------------

interface ConfirmationBatchProps {
  state: ApprovalState;
  toolName: string;
  entries: BatchApprovalEntry[];
  /**
   * 用户批准。`remember=true` 表示选择了「始终允许该工具」——把工具加入
   * 任务白名单,后续同类调用自动放行;`false` 只批准当前显示的这些操作。
   */
  onApprove: (remember: boolean) => void;
  onDeny: () => void;
  /** Max entries shown before "+N more" collapse. Default 5. */
  previewLimit?: number;
  className?: string;
}

export const ConfirmationBatch = ({
  state,
  toolName,
  entries,
  onApprove,
  onDeny,
  previewLimit = 5,
  className,
}: ConfirmationBatchProps) => {
  const { LL } = useI18nContext();
  const count = entries.length;
  const visible = entries.slice(0, previewLimit);
  const hidden = Math.max(0, count - previewLimit);
  // 用本地化工具名(如「删除文件」)而非原始 toolName(deleteFile)
  const label = getToolLabels(LL)[toolName] || toolName;
  const single = count === 1;

  return (
    <Confirmation state={state} className={className}>
      <ConfirmationRequest>
        <div className="flex flex-col gap-1">
          <div className="font-medium">
            {single ? `批准${label}操作？` : `批准 ${count} 个${label}操作？`}
          </div>
          <div className="ml-1 mt-0.5 space-y-1 text-foreground/70">
            {visible.map((e) => (
              <PreviewEntryRow key={e.toolCallId} entry={e} LL={LL} />
            ))}
            {hidden > 0 && (
              <div className="text-foreground/50">…还有 {hidden} 个</div>
            )}
          </div>
        </div>
      </ConfirmationRequest>
      {state === "approval-requested" && (
        <ConfirmationActions>
          <ConfirmationAction
            variant="default"
            onClick={() => onApprove(false)}
          >
            {single ? "批准" : `批准全部 ${count} 个`}
          </ConfirmationAction>
          <ConfirmationAction variant="outline" onClick={() => onApprove(true)}>
            始终允许{label}
          </ConfirmationAction>
          <ConfirmationAction variant="destructive" onClick={onDeny}>
            {single ? "拒绝" : "拒绝全部"}
          </ConfirmationAction>
        </ConfirmationActions>
      )}
      {state === "approval-accepted" && (
        <ConfirmationAccepted>
          {single ? "已批准" : `已批准 ${count} 个操作`}
        </ConfirmationAccepted>
      )}
      {state === "approval-rejected" && (
        <ConfirmationRejected>
          {single ? "已拒绝" : `已拒绝 ${count} 个操作`}
        </ConfirmationRejected>
      )}
    </Confirmation>
  );
};
