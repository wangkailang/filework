import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Part types (slimmed-down versions of the renderer's MessagePart types)
// ---------------------------------------------------------------------------

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  state?: string;
}

export interface PlanMessagePart {
  type: "plan";
  plan: unknown;
}

export type MessagePart = TextPart | ToolPart | PlanMessagePart;

/**
 * Slimmed-down version of ChatMessage for IPC transport.
 * Excludes id, sessionId, timestamp to reduce payload size.
 */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  parts?: MessagePart[];
}

const TOOL_RESULT_PLACEHOLDER = "[工具执行结果未记录]";

/**
 * Convert frontend HistoryMessage[] to Vercel AI SDK ModelMessage[].
 *
 * Conversion rules:
 * - user message → { role: "user", content }
 * - assistant TextPart → { role: "assistant", content: [{ type: "text", text }] }
 * - assistant ToolPart → assistant tool-call content part + separate tool role message
 * - PlanMessagePart → ignored
 * - ToolPart missing result → placeholder text used
 * - Message chronological order is preserved
 */
export function convertToCoreMessages(
  history: HistoryMessage[],
): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of history) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      continue;
    }

    // assistant message — process parts
    if (!msg.parts || msg.parts.length === 0) {
      // No parts, use content string directly
      if (msg.content) {
        result.push({ role: "assistant", content: msg.content });
      }
      continue;
    }

    const textParts: Array<{ type: "text"; text: string }> = [];
    const toolCallParts: Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }> = [];
    const toolResults: Array<{
      toolCallId: string;
      toolName: string;
      result: unknown;
    }> = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "text": {
          const tp = part as TextPart;
          if (tp.text) {
            textParts.push({ type: "text", text: tp.text });
          }
          break;
        }
        case "tool": {
          const tp = part as ToolPart;
          toolCallParts.push({
            type: "tool-call",
            toolCallId: tp.toolCallId,
            toolName: tp.toolName,
            input: tp.args,
          });
          toolResults.push({
            toolCallId: tp.toolCallId,
            toolName: tp.toolName,
            result: tp.result ?? TOOL_RESULT_PLACEHOLDER,
          });
          break;
        }
        // "plan" and any other unknown types are ignored
        default:
          break;
      }
    }

    // Build assistant message content array
    const assistantContent: Array<
      | { type: "text"; text: string }
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: unknown;
        }
    > = [...textParts, ...toolCallParts];

    if (assistantContent.length > 0) {
      result.push({ role: "assistant", content: assistantContent });
    }

    // Generate tool role messages for each tool call
    if (toolResults.length > 0) {
      result.push({
        role: "tool",
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: formatToolResult(tr.result),
        })),
      });
    }
  }

  return result;
}

/**
 * Format a tool result into the ToolResultOutput format expected by the AI SDK.
 */
function formatToolResult(result: unknown): { type: "text"; value: string } {
  if (typeof result === "string") {
    return { type: "text", value: result };
  }
  try {
    return { type: "text", value: JSON.stringify(result) };
  } catch {
    return { type: "text", value: String(result) };
  }
}
