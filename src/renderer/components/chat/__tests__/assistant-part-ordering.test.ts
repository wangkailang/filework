import { describe, expect, it } from "vitest";
import { movePendingBatchApprovalsToEnd } from "../assistant-part-ordering";
import type { MessagePart } from "../types";

describe("movePendingBatchApprovalsToEnd", () => {
  it("moves pending batch approval cards after already-rendered assistant content", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "I will create an automation." },
      {
        type: "batch-approval",
        batchId: "pending-batch",
        toolName: "automation_update",
        entries: [
          {
            toolCallId: "call-1",
            args: { action: "create" },
            description: "automation_update",
          },
        ],
        state: "approval-requested",
      },
      {
        type: "tool",
        toolCallId: "call-0",
        toolName: "automation_update",
        args: { action: "list" },
        result: { action: "list" },
        state: "output-available",
      },
      { type: "text", text: "Existing generated explanation." },
      {
        type: "batch-approval",
        batchId: "accepted-batch",
        toolName: "automation_update",
        entries: [],
        state: "approval-accepted",
      },
    ];

    expect(
      movePendingBatchApprovalsToEnd(parts).map((part) => part.type),
    ).toEqual(["text", "tool", "text", "batch-approval", "batch-approval"]);
    expect(movePendingBatchApprovalsToEnd(parts).at(-1)).toMatchObject({
      type: "batch-approval",
      batchId: "pending-batch",
      state: "approval-requested",
    });
  });
});
