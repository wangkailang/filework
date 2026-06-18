import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import type {
  ApprovalState,
  BatchApprovalEntry,
} from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  getBatchApprovalTitle,
  getBatchToolLabel,
  summarizeBatchEntry,
} from "./confirmation-copy";
import { PreviewEntryRow } from "./preview";

// ---------------------------------------------------------------------------
// 类型 —— 从共享的核心类型中重新导出,使 JSONL 会话存储与渲染进程
// 共享同一份事实来源。
// ---------------------------------------------------------------------------

export type { ApprovalState } from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// 根容器
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
      "rounded-md border text-xs",
      state === "approval-requested" &&
        "border-status-await/40 bg-status-await/5",
      state === "approval-accepted" &&
        "border-status-success/40 bg-status-success/5",
      state === "approval-rejected" &&
        "border-status-error/40 bg-status-error/5",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// 请求(等待用户决定时显示)
// ---------------------------------------------------------------------------

export const ConfirmationRequest = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-start gap-1.5 px-2.5 py-2", className)}
    {...props}
  >
    <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-status-await" />
    <div className="text-foreground/90 text-xs leading-relaxed">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------
// 已批准
// ---------------------------------------------------------------------------

export const ConfirmationAccepted = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-1.5 px-2.5 py-1.5", className)}
    {...props}
  >
    <CheckCircle2 className="size-3.5 text-status-success shrink-0" />
    <span className="text-xs text-status-success">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// 已拒绝
// ---------------------------------------------------------------------------

export const ConfirmationRejected = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-1.5 px-2.5 py-1.5", className)}
    {...props}
  >
    <XCircle className="size-3.5 text-status-error shrink-0" />
    <span className="text-xs text-status-error">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// 操作(批准 / 拒绝按钮)
// ---------------------------------------------------------------------------

export const ConfirmationActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-1.5 px-2.5 pb-2", className)}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// 操作按钮
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
  <Button
    type="button"
    disabled={disabled}
    variant={variant}
    size="xs"
    className={cn(
      variant === "default" &&
        "bg-status-await text-status-await-foreground hover:bg-status-await/90",
      className,
    )}
    {...props}
  >
    {children}
  </Button>
);

// ---------------------------------------------------------------------------
// 批量 —— 由 approval-batcher 合并的 N 个破坏性调用共用一张卡片
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
  /** 折叠为 "+N more" 之前最多显示的条目数。默认 5。 */
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
  const label = getBatchToolLabel(LL, toolName);
  const single = count === 1;
  const title = getBatchApprovalTitle({ LL, toolName, entries });

  return (
    <Confirmation state={state} className={className}>
      {state === "approval-requested" && (
        <ConfirmationRequest>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="font-medium">{title}</div>
            <div className="space-y-0.5 text-foreground/70">
              {visible.map((e) => {
                const summary = summarizeBatchEntry(toolName, e, LL);
                if (summary) {
                  return (
                    <div key={e.toolCallId} className="truncate">
                      {summary}
                    </div>
                  );
                }
                return <PreviewEntryRow key={e.toolCallId} entry={e} LL={LL} />;
              })}
              {hidden > 0 && (
                <div className="text-foreground/50">
                  {LL.approval_batch_more(hidden)}
                </div>
              )}
            </div>
          </div>
        </ConfirmationRequest>
      )}
      {state === "approval-requested" && (
        <ConfirmationActions>
          <ConfirmationAction
            variant="default"
            onClick={() => onApprove(false)}
          >
            {single ? LL.chat_approve() : LL.approval_batch_approve_all(count)}
          </ConfirmationAction>
          <ConfirmationAction variant="outline" onClick={() => onApprove(true)}>
            {LL.approval_batch_always_allow(label)}
          </ConfirmationAction>
          <ConfirmationAction variant="destructive" onClick={onDeny}>
            {single ? LL.chat_reject() : LL.approval_batch_reject_all()}
          </ConfirmationAction>
        </ConfirmationActions>
      )}
      {state === "approval-accepted" && (
        <ConfirmationAccepted>
          {single
            ? `${LL.chat_approved()} · ${label}`
            : LL.approval_batch_accepted_multiple(count)}
        </ConfirmationAccepted>
      )}
      {state === "approval-rejected" && (
        <ConfirmationRejected>
          {single
            ? `${LL.chat_rejected()} · ${label}`
            : LL.approval_batch_rejected_multiple(count)}
        </ConfirmationRejected>
      )}
    </Confirmation>
  );
};
