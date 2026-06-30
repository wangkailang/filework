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

  it("does not accept a batch approval until every requested tool call produced a result", () => {
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
          {
            toolCallId: "call-2",
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
      state: "approval-rejected",
    });
  });

  it("marks an executing plan failed when the task ends before pending steps start", () => {
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
        status: "failed",
        steps: [{ status: "completed" }, { status: "skipped" }],
      },
    });
  });

  it("completes stale pending plan steps when the task delivered a final answer", () => {
    const parts: MessagePart[] = [
      {
        type: "plan",
        plan: {
          id: "inline-task-1",
          goal: "Compare frontend state managers",
          status: "executing",
          steps: [
            {
              id: 1,
              action: "Research React state management",
              description: "",
              status: "completed",
            },
            {
              id: 2,
              action: "Research Vue state management",
              description: "",
              status: "pending",
            },
            {
              id: 3,
              action: "Research Svelte state management",
              description: "",
              status: "pending",
            },
          ],
        },
      },
      {
        type: "text",
        text: "React, Vue, and Svelte research is complete. Here are the conclusions.",
      },
    ];

    const finalized = finalizePartsForSettledTask(parts, {
      status: "completed",
    });

    expect(finalized[0]).toMatchObject({
      type: "plan",
      plan: {
        status: "completed",
        steps: [
          { status: "completed" },
          { status: "completed" },
          { status: "completed" },
        ],
      },
    });
  });

  it("clears running and pending steps when an executing plan is cancelled", () => {
    const parts: MessagePart[] = [
      {
        type: "plan",
        plan: {
          id: "inline-task-1",
          goal: "Generate cache diagram",
          status: "executing",
          steps: [
            {
              id: 1,
              action: "Read cache chapter",
              description: "",
              status: "running",
              subSteps: [
                { label: "Open issue", status: "done" },
                { label: "Extract cache details", status: "pending" },
              ],
            },
            {
              id: 2,
              action: "Create SVG",
              description: "",
              status: "pending",
            },
          ],
        },
      },
    ];

    const finalized = finalizePartsForSettledTask(parts, {
      status: "cancelled",
    });

    expect(finalized[0]).toMatchObject({
      type: "plan",
      plan: {
        status: "cancelled",
        steps: [
          {
            status: "skipped",
            subSteps: [{ status: "done" }, { status: "pending" }],
          },
          { status: "skipped" },
        ],
      },
    });
  });

  it("marks running plan progress failed when a task ends with an error", () => {
    const parts: MessagePart[] = [
      {
        type: "plan",
        plan: {
          id: "inline-task-1",
          goal: "Highlight file references",
          status: "executing",
          steps: [
            {
              id: 1,
              action: "Locate renderer output",
              description: "",
              status: "running",
            },
            {
              id: 2,
              action: "Patch UI state",
              description: "",
              status: "pending",
            },
          ],
        },
      },
      {
        type: "error",
        message: "Task interrupted unexpectedly",
        errorType: "server_error",
      },
    ];

    const finalized = finalizePartsForSettledTask(parts, {
      status: "failed",
    });

    expect(finalized[0]).toMatchObject({
      type: "plan",
      plan: {
        status: "failed",
        steps: [{ status: "failed" }, { status: "skipped" }],
      },
    });
  });
});
