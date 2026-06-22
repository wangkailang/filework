import type { MessagePart } from "./types";

export const movePendingBatchApprovalsToEnd = (
  parts: MessagePart[],
): MessagePart[] => {
  const pending: MessagePart[] = [];
  const settledOrContent: MessagePart[] = [];

  for (const part of parts) {
    if (part.type === "batch-approval" && part.state === "approval-requested") {
      pending.push(part);
    } else {
      settledOrContent.push(part);
    }
  }

  if (pending.length === 0) return parts;
  return [...settledOrContent, ...pending];
};
