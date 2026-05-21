import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  Loader2,
  SkipForward,
  XCircle,
} from "lucide-react";
import {
  type HTMLAttributes,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  PlanStepArtifactView,
  PlanStepView,
  PlanSubStepView,
  PlanView,
} from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { getToolLabels } from "./tool-labels";

// ---------------------------------------------------------------------------
// Types — re-exported from the shared core types so the JSONL session store
// and the renderer agree on a single source of truth. (See
// src/main/ipc/plan-types.ts for the planner's executor view of Plan.)
// ---------------------------------------------------------------------------

export type {
  PlanStepArtifactView,
  PlanStepView,
  PlanSubStepView,
  PlanView,
} from "../../../main/core/session/message-parts";

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
// Running step elapsed timer
// ---------------------------------------------------------------------------

const RunningStepTimer = ({ isStalled }: { isStalled: boolean }) => {
  const { LL } = useI18nContext();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setElapsed(0);
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr =
    minutes > 0
      ? `${minutes}:${seconds.toString().padStart(2, "0")}`
      : `${seconds}s`;

  return (
    <span
      className={cn(
        "ml-1 text-[10px] tabular-nums",
        isStalled ? "text-amber-500" : "text-muted-foreground",
      )}
    >
      {isStalled && <AlertTriangle className="inline size-3 mr-0.5 -mt-0.5" />}
      {timeStr}
      {isStalled && ` ${LL.plan_stalled()}`}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Sub-step list
// ---------------------------------------------------------------------------

const SubStepList = ({
  id,
  subSteps,
  stepStatus,
  stepFailed,
}: {
  id: string;
  subSteps: PlanSubStepView[];
  stepStatus: PlanStepView["status"];
  stepFailed: boolean;
}) => {
  const firstPendingIdx =
    stepStatus === "running"
      ? subSteps.findIndex((s) => s.status === "pending")
      : -1;

  return (
    <div
      id={id}
      className="ml-6 mt-1 space-y-0.5 border-l border-border/50 pl-2"
    >
      {subSteps.map((sub, idx) => {
        const isFirstPending =
          sub.status === "pending" && idx === firstPendingIdx;
        const isUnfinished = stepFailed && sub.status === "pending";

        return (
          <div
            key={`${id}-${sub.label}`}
            className="flex items-center gap-1.5 text-[11px]"
          >
            {sub.status === "done" ? (
              <CheckCircle2 className="size-3 text-green-500 shrink-0" />
            ) : isUnfinished ? (
              <XCircle className="size-3 text-red-400/60 shrink-0" />
            ) : isFirstPending ? (
              <Loader2 className="size-3 text-blue-500 animate-spin shrink-0" />
            ) : (
              <Circle className="size-3 text-muted-foreground/40 shrink-0" />
            )}
            <span
              className={cn(
                sub.status === "done"
                  ? "text-muted-foreground line-through"
                  : isUnfinished
                    ? "text-red-400/60 line-through"
                    : "text-foreground/70",
              )}
            >
              {sub.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Artifact list — shows tool operations with details
// ---------------------------------------------------------------------------

/** Keys to exclude from args summary (may contain large or sensitive data) */
const hiddenArgKeys = new Set(["content", "data", "body"]);

/** Format tool args into a brief one-line summary */
const formatArgsSummary = (args: Record<string, unknown>): string => {
  if (args.path) return String(args.path);
  if (args.source && args.destination)
    return `${args.source} → ${args.destination}`;
  const keys = Object.keys(args).filter((k) => !hiddenArgKeys.has(k));
  if (keys.length === 0) return "";
  return keys
    .map((k) => {
      const v = args[k];
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s && s.length > 60 ? `${s.slice(0, 60)}...` : s;
    })
    .join(", ");
};

/** Format a tool result for display */
const formatResult = (result: unknown): string => {
  if (result == null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
};

const ArtifactItem = ({ artifact }: { artifact: PlanStepArtifactView }) => {
  const { LL } = useI18nContext();
  const [open, setOpen] = useState(false);
  const toolLabelMap = useMemo(() => getToolLabels(LL), [LL]);
  const label = toolLabelMap[artifact.toolName] || artifact.toolName;
  const summary = formatArgsSummary(artifact.args);

  return (
    <div className="text-[11px]">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full text-left bg-transparent border-none p-0 cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        {artifact.success ? (
          <CheckCircle2 className="size-3 text-green-500 shrink-0" />
        ) : (
          <XCircle className="size-3 text-red-400 shrink-0" />
        )}
        <span className="text-foreground/80 font-medium shrink-0">{label}</span>
        {summary && (
          <span className="text-muted-foreground truncate" title={summary}>
            {summary}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground/50 ml-auto">
          {open ? (
            <ChevronDown className="size-2.5" />
          ) : (
            <ChevronRight className="size-2.5" />
          )}
        </span>
      </button>
      {open && artifact.result != null && (
        <pre className="mt-0.5 ml-4.5 px-2 py-1 rounded bg-muted/60 text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-all max-h-40 overflow-auto">
          {formatResult(artifact.result)}
        </pre>
      )}
    </div>
  );
};

const ArtifactList = ({ artifacts }: { artifacts: PlanStepArtifactView[] }) => {
  const { LL } = useI18nContext();
  return (
    <div className="ml-6 mt-1.5 space-y-1 border-l border-border/50 pl-2">
      <div className="text-[10px] text-muted-foreground/60 mb-0.5">
        {LL.plan_artifacts(String(artifacts.length))}
      </div>
      {artifacts.map((a) => (
        <ArtifactItem key={a.toolCallId} artifact={a} />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Step reasoning (collapsible "thinking" text bound to a specific step)
// ---------------------------------------------------------------------------

const StepReasoning = ({
  text,
  defaultOpen,
}: {
  text: string;
  defaultOpen: boolean;
}) => {
  const { LL } = useI18nContext();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ml-6 mt-1.5 border-l border-border/50 pl-2">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full text-left bg-transparent border-none p-0 cursor-pointer select-none text-[11px] text-muted-foreground/80"
        onClick={() => setOpen((o) => !o)}
      >
        <Brain className="size-3 shrink-0" />
        <span className="font-medium">{LL.plan_reasoning()}</span>
        {open ? (
          <ChevronDown className="size-2.5 shrink-0 text-muted-foreground/50 ml-auto" />
        ) : (
          <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50 ml-auto" />
        )}
      </button>
      {open && (
        <div className="mt-0.5 px-2 py-1 rounded bg-muted/40 text-[10.5px] leading-relaxed text-foreground/70 whitespace-pre-wrap break-words max-h-60 overflow-auto">
          {text}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Single step row — memoized so reasoning deltas on the currently-running
// step (which produce a new `step` object for that step only) don't cause
// sibling steps to re-render. The default React.memo shallow comparison is
// sufficient: when reasoning is appended in `useStreamSubscription`, only
// the running step's object reference changes; pending/completed steps
// keep their identity and short-circuit here.
// ---------------------------------------------------------------------------

interface StepRowProps {
  step: PlanStepView;
  isExpanded: boolean;
  isStalled: boolean;
  onToggle: (stepId: number) => void;
}

const StepRowImpl = ({
  step,
  isExpanded,
  isStalled,
  onToggle,
}: StepRowProps) => {
  const { LL } = useI18nContext();
  const hasSubSteps = step.subSteps && step.subSteps.length > 0;
  const hasArtifacts = step.artifacts && step.artifacts.length > 0;
  const hasReasoning = !!step.reasoning && step.reasoning.length > 0;
  const hasExpandable = hasSubSteps || hasArtifacts || hasReasoning;
  const stepFailed = step.status === "failed" || step.status === "skipped";
  const subStepListId = `substeps-${step.id}`;

  const stepContent = (
    <>
      <StepIcon status={step.status} />
      <div className="flex-1 min-w-0">
        <span
          className={cn(
            "text-xs",
            step.status === "completed" && "text-muted-foreground line-through",
            step.status === "running" && "text-foreground font-medium",
            step.status === "failed" && "text-red-400",
            step.status === "skipped" && "text-muted-foreground",
            step.status === "pending" && "text-foreground/80",
          )}
        >
          {step.action} — {step.description}
          {step.status === "running" && (
            <RunningStepTimer isStalled={isStalled} />
          )}
        </span>
        {step.verification && (
          <div className="text-[10px] text-muted-foreground/70 mt-0.5">
            {LL.plan_verify()}: {step.verification}
          </div>
        )}
        {step.error && (
          <div className="text-xs text-red-400 mt-0.5">
            {LL.plan_stepError(step.error)}
          </div>
        )}
      </div>
      {hasExpandable &&
        (isExpanded ? (
          <ChevronDown className="size-3 shrink-0 mt-0.5 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="size-3 shrink-0 mt-0.5 text-muted-foreground/60" />
        ))}
    </>
  );

  return (
    <div>
      {hasExpandable ? (
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={subStepListId}
          className="flex items-start gap-2 w-full text-left cursor-pointer select-none bg-transparent border-none p-0"
          onClick={() => onToggle(step.id)}
        >
          {stepContent}
        </button>
      ) : (
        <div className="flex items-start gap-2">{stepContent}</div>
      )}

      {hasSubSteps && isExpanded && (
        <SubStepList
          id={subStepListId}
          subSteps={step.subSteps ?? []}
          stepStatus={step.status}
          stepFailed={stepFailed}
        />
      )}

      {/* Auto-open reasoning while the step is running; once it completes the
          user can re-collapse, but we don't force-close on transition. */}
      {hasReasoning && isExpanded && step.reasoning && (
        <StepReasoning
          text={step.reasoning}
          defaultOpen={step.status === "running"}
        />
      )}

      {hasArtifacts && isExpanded && (
        <ArtifactList artifacts={step.artifacts ?? []} />
      )}
    </div>
  );
};

const StepRow = memo(StepRowImpl);

// ---------------------------------------------------------------------------
// Plan Viewer (draft state — shows plan for approval)
// ---------------------------------------------------------------------------

interface PlanViewerProps extends HTMLAttributes<HTMLDivElement> {
  plan: PlanView;
  /** Whether the current running step appears stalled (no activity) */
  isStalled?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
}

export const PlanViewer = ({
  plan,
  isStalled = false,
  onApprove,
  onReject,
  onCancel,
  className,
  ...props
}: PlanViewerProps) => {
  const { LL } = useI18nContext();
  const isDraft = plan.status === "draft";
  const isExecuting = plan.status === "executing" || plan.status === "approved";
  const completedSteps = plan.steps.filter(
    (s) => s.status === "completed",
  ).length;

  // Track which steps are expanded — running steps auto-expand
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpand = useCallback((stepId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }, []);

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
          <div className="font-medium text-foreground text-xs">
            {LL.plan_title()}
          </div>
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
        {plan.steps.map((step) => {
          const hasSubSteps = !!(step.subSteps && step.subSteps.length > 0);
          const stepFailed =
            step.status === "failed" || step.status === "skipped";
          const isExpanded =
            expanded.has(step.id) ||
            step.status === "running" ||
            (stepFailed && hasSubSteps);
          return (
            <StepRow
              key={step.id}
              step={step}
              isExpanded={isExpanded}
              isStalled={isStalled}
              onToggle={toggleExpand}
            />
          );
        })}
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
              {LL.plan_reject()}
            </button>
          )}
          {onApprove && (
            <button
              type="button"
              onClick={onApprove}
              className="inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {LL.plan_start()}
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
            {LL.plan_cancel()}
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
          {plan.status === "completed" && LL.plan_completed()}
          {plan.status === "failed" && LL.plan_failed()}
          {plan.status === "cancelled" && LL.plan_cancelled()}
        </div>
      )}
    </div>
  );
};
