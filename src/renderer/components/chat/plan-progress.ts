import type { PlanView } from "../../../main/core/session/message-parts";

const hasStartedStep = (plan: PlanView): boolean =>
  plan.steps.some((step) => step.status !== "pending");

export const beginPlanExecution = (plan: PlanView): PlanView => {
  if (hasStartedStep(plan)) {
    return { ...plan, status: "executing" };
  }

  return {
    ...plan,
    status: "executing",
    steps: plan.steps.map((step, index) =>
      index === 0 ? { ...step, status: "running" } : step,
    ),
  };
};

export const cancelPlanExecution = (plan: PlanView): PlanView => ({
  ...plan,
  status: "cancelled",
  steps: plan.steps.map((step) =>
    step.status === "running" || step.status === "pending"
      ? { ...step, status: "skipped" }
      : step,
  ),
});
