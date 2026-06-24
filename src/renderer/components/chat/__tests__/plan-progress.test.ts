import { describe, expect, it } from "vitest";
import type { PlanView } from "../../../../main/core/session/message-parts";
import { beginPlanExecution, cancelPlanExecution } from "../plan-progress";

describe("plan progress state", () => {
  it("marks the first pending step as running when a draft plan starts", () => {
    const plan: PlanView = {
      id: "inline-task-1",
      goal: "Fix the bug",
      status: "draft",
      steps: [
        {
          id: 1,
          action: "Trace root cause",
          description: "Inspect the event flow",
          status: "pending",
        },
        {
          id: 2,
          action: "Patch state update",
          description: "Apply the minimal fix",
          status: "pending",
        },
      ],
    };

    const started = beginPlanExecution(plan);

    expect(started.status).toBe("executing");
    expect(started.steps.map((step) => step.status)).toEqual([
      "running",
      "pending",
    ]);
    expect(plan.steps.map((step) => step.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("skips unfinished steps when a plan is cancelled", () => {
    const plan: PlanView = {
      id: "inline-task-1",
      goal: "Fix the bug",
      status: "executing",
      steps: [
        {
          id: 1,
          action: "Trace root cause",
          description: "Inspect the event flow",
          status: "completed",
        },
        {
          id: 2,
          action: "Patch state update",
          description: "Apply the minimal fix",
          status: "running",
        },
        {
          id: 3,
          action: "Verify",
          description: "Run checks",
          status: "pending",
        },
      ],
    };

    const cancelled = cancelPlanExecution(plan);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps.map((step) => step.status)).toEqual([
      "completed",
      "skipped",
      "skipped",
    ]);
    expect(plan.steps.map((step) => step.status)).toEqual([
      "completed",
      "running",
      "pending",
    ]);
  });
});
