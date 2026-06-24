import type { ApprovalState } from "../../../main/core/session/message-parts";
import { cancelPlanExecution } from "./plan-progress";
import type {
  BatchApprovalPart,
  MessagePart,
  PlanMessagePart,
  ToolPart,
} from "./types";

export const finalizePartsForSettledTask = (
  parts: MessagePart[],
  options: { status: "completed" | "cancelled"; cancelledReason?: string },
): MessagePart[] => {
  const toolResults = new Map<
    string,
    { delivered: boolean; denied: boolean }
  >();
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const tool = part as ToolPart;
    const result =
      tool.result != null && typeof tool.result === "object"
        ? (tool.result as Record<string, unknown>)
        : null;
    toolResults.set(tool.toolCallId, {
      delivered:
        tool.state === "output-available" || tool.state === "output-error",
      denied: result?.denied === true,
    });
  }

  return parts.map((part) => {
    if (part.type === "plan") {
      const planPart = part as PlanMessagePart;
      if (
        planPart.plan.status !== "draft" &&
        planPart.plan.status !== "approved" &&
        planPart.plan.status !== "executing"
      ) {
        return part;
      }

      if (options.status === "cancelled") {
        return {
          type: "plan",
          plan: cancelPlanExecution(planPart.plan),
        };
      }

      const hadPendingSteps = planPart.plan.steps.some(
        (step) => step.status === "pending",
      );
      const steps = planPart.plan.steps.map((step) => {
        if (step.status === "running") {
          return {
            ...step,
            status: "completed" as const,
            subSteps: step.subSteps?.map((subStep) => ({
              ...subStep,
              status: "done" as const,
            })),
          };
        }
        if (step.status === "pending") {
          return { ...step, status: "skipped" as const };
        }
        return step;
      });
      return {
        type: "plan",
        plan: {
          ...planPart.plan,
          status:
            steps.some((step) => step.status === "failed") || hadPendingSteps
              ? ("failed" as const)
              : ("completed" as const),
          steps,
        },
      };
    }

    if (part.type === "tool") {
      const tool = part as ToolPart;
      if (options.status !== "cancelled") return part;
      if (tool.state === "output-available" || tool.state === "output-error") {
        return part;
      }
      return {
        ...tool,
        state: "output-available" as const,
        result: tool.result ?? {
          success: false,
          cancelled: true,
          reason: options.cancelledReason ?? "Cancelled",
        },
      };
    }

    if (part.type === "batch-approval") {
      const batch = part as BatchApprovalPart;
      if (batch.state !== "approval-requested") return part;
      const matchingResults = batch.entries
        .map((entry) => toolResults.get(entry.toolCallId))
        .filter((result): result is { delivered: boolean; denied: boolean } =>
          Boolean(result),
        );
      const allEntriesDelivered =
        matchingResults.length === batch.entries.length &&
        matchingResults.every((result) => result.delivered);
      const nextState: ApprovalState =
        matchingResults.some((result) => result.denied) || !allEntriesDelivered
          ? "approval-rejected"
          : "approval-accepted";
      return { ...batch, state: nextState };
    }

    return part;
  });
};
