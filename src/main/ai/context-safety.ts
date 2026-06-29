import type { ModelMessage } from "ai";

const MISSING_TOOL_RESULT_PLACEHOLDER =
  "[工具结果未保留：上下文压缩已移除旧结果]";

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
}

export interface ToolResultRepairResult {
  messages: ModelMessage[];
  repairedToolCallIds: string[];
}

export function repairMissingToolResults(
  messages: ModelMessage[],
): ToolResultRepairResult {
  const repairedToolCallIds: string[] = [];
  const repairedMessages: ModelMessage[] = [];
  const pending = new Map<string, PendingToolCall>();
  let changed = false;

  const flushPending = () => {
    if (pending.size === 0) return;
    changed = true;
    const content = Array.from(pending.values()).map((call) => ({
      type: "tool-result" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: {
        type: "text" as const,
        value: MISSING_TOOL_RESULT_PLACEHOLDER,
      },
    }));
    repairedToolCallIds.push(...content.map((part) => part.toolCallId));
    repairedMessages.push({ role: "tool", content });
    pending.clear();
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      flushPending();
      repairedMessages.push(message);
      collectPendingToolCalls(message, pending);
      continue;
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          pending.delete(part.toolCallId);
        }
      }
    }
    repairedMessages.push(message);
  }

  flushPending();

  return {
    messages: changed ? repairedMessages : messages,
    repairedToolCallIds,
  };
}

function collectPendingToolCalls(
  message: ModelMessage,
  pending: Map<string, PendingToolCall>,
): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (
      part.type === "tool-call" &&
      !("providerExecuted" in part && part.providerExecuted === true)
    ) {
      pending.set(part.toolCallId, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      });
    }
  }
}
