import { describe, expect, it } from "vitest";
import { finalizePartsForSettledTask } from "../stream-finalize";
import type { MessagePart } from "../types";

describe("finalizePartsForSettledTask", () => {
  it("marks a stale batch approval accepted when its tool call already produced a result", () => {
    const parts: MessagePart[] = [
      {
        type: "batch-approval",
        batchId: "batch-1",
        toolName: "automation_update",
        entries: [
          {
            toolCallId: "call-1",
            args: { operation: "create" },
            description: "automation_update",
          },
        ],
        state: "approval-requested",
      },
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "automation_update",
        args: { operation: "create" },
        result: { id: "auto-1" },
        state: "output-available",
      },
    ];

    const finalized = finalizePartsForSettledTask(parts, {
      status: "completed",
    });

    expect(finalized[0]).toMatchObject({
      type: "batch-approval",
      state: "approval-accepted",
    });
  });

  it("completes an executing plan and skips steps that never received progress updates", () => {
    const parts: MessagePart[] = [
      {
        type: "plan",
        plan: {
          id: "inline-task-1",
          goal: "Run repository report",
          status: "executing",
          steps: [
            {
              id: 1,
              action: "Inspect repository",
              description: "",
              status: "running",
            },
            {
              id: 2,
              action: "Summarize commits",
              description: "",
              status: "pending",
            },
          ],
        },
      },
    ];

    const finalized = finalizePartsForSettledTask(parts, {
      status: "completed",
    });

    expect(finalized[0]).toMatchObject({
      type: "plan",
      plan: {
        status: "completed",
        steps: [{ status: "completed" }, { status: "skipped" }],
      },
    });
  });
});
