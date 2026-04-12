import {
  CheckCircle2,
  Circle,
  ListChecks,
  Loader2,
  SkipForward,
  XCircle,
} from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Types (mirrors src/main/planner/types.ts for renderer use)
// ---------------------------------------------------------------------------

export interface PlanStepView {
  id: number;
  action: string;
  description: string;
  skillId?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  error?: string;
}

export interface PlanView {
  id: string;
  goal: string;
  steps: PlanStepView[];
  status:
    | "draft"
    | "approved"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
}

// ---------------------------------------------------------------------------
// Step status icon
// ---------------------------------------------------------------------------

const StepIcon = ({ status }: { status: PlanStepView["status"] }) => {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-4 text-green-500 shrink-0" />;
    case "running":
      return <Loader2 className="size-4 text-blue-500 animate-spin shrink-0" />;
    case "failed":
      return <XCircle className="size-4 text-red-500 shrink-0" />;
    case "skipped":
      return <SkipForward className="size-4 text-muted-foreground shrink-0" />;
    default:
      return <Circle className="size-4 text-muted-foreground/50 shrink-0" />;
  }
};

// ---------------------------------------------------------------------------
// Plan Viewer (draft state — shows plan for approval)
// ---------------------------------------------------------------------------

interface PlanViewerProps extends HTMLAttributes<HTMLDivElement> {
  plan: PlanView;
  onApprove?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
}

export const PlanViewer = ({
  plan,
  onApprove,
  onReject,
  onCancel,
  className,
  ...props
}: PlanViewerProps) => {
  const isDraft = plan.status === "draft";
  const isExecuting = plan.status === "executing" || plan.status === "approved";
  const completedSteps = plan.steps.filter(
    (s) => s.status === "completed",
  ).length;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-sm",
        className,
      )}
      {...props}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-3 py-2.5 border-b border-border">
        <ListChecks className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground text-xs">执行计划</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {plan.goal}
          </div>
        </div>
        {isExecuting && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {completedSteps}/{plan.steps.length}
          </span>
        )}
      </div>

      {/* Steps */}
      <div className="px-3 py-2 space-y-1.5">
        {plan.steps.map((step) => (
          <div key={step.id} className="flex items-start gap-2">
            <StepIcon status={step.status} />
            <div className="flex-1 min-w-0">
              <span
                className={cn(
                  "text-xs",
                  step.status === "completed" &&
                    "text-muted-foreground line-through",
                  step.status === "running" && "text-foreground font-medium",
                  step.status === "failed" && "text-red-400",
                  step.status === "skipped" && "text-muted-foreground",
                  step.status === "pending" && "text-foreground/80",
                )}
              >
                {step.action} — {step.description}
              </span>
              {step.error && (
                <div className="text-xs text-red-400 mt-0.5">
                  错误: {step.error}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      {isDraft && (onApprove || onReject) && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          {onReject && (
            <button
              type="button"
              onClick={onReject}
              className="inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium border border-border bg-transparent hover:bg-accent hover:text-foreground transition-colors"
            >
              拒绝
            </button>
          )}
          {onApprove && (
            <button
              type="button"
              onClick={onApprove}
              className="inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              开始执行
            </button>
          )}
        </div>
      )}

      {isExecuting && onCancel && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium border border-border bg-transparent hover:bg-accent hover:text-foreground transition-colors"
          >
            取消执行
          </button>
        </div>
      )}

      {/* Completed / Failed / Cancelled status */}
      {(plan.status === "completed" ||
        plan.status === "failed" ||
        plan.status === "cancelled") && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-2 border-t border-border text-xs",
            plan.status === "completed" && "text-green-500",
            plan.status === "failed" && "text-red-400",
            plan.status === "cancelled" && "text-muted-foreground",
          )}
        >
          {plan.status === "completed" && <CheckCircle2 className="size-3.5" />}
          {plan.status === "failed" && <XCircle className="size-3.5" />}
          {plan.status === "completed" && "计划执行完成"}
          {plan.status === "failed" && "计划执行失败"}
          {plan.status === "cancelled" && "计划已取消"}
        </div>
      )}
    </div>
  );
};
