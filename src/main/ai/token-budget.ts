import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TOKEN_BUDGET = 80000;
const TOOL_RESULT_COMPRESS_THRESHOLD = 2000;
const TOKEN_ESTIMATE_RATIO = 4;
const TRUNCATION_NOTICE =
  "[系统提示] 部分早期对话已被省略，以下为最近的对话内容。";
const COMPRESSED_PLACEHOLDER = "[工具结果已压缩]";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TruncationResult {
  messages: ModelMessage[];
  wasTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token count of a single string.
 * Uses a simple heuristic: Math.ceil(charCount / 4).
 */
function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATE_RATIO);
}

/**
 * Estimate the total token count for a ModelMessage array.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

function estimateMessageTokens(msg: ModelMessage): number {
  if (typeof msg.content === "string") {
    return estimateStringTokens(msg.content);
  }
  if (!Array.isArray(msg.content)) return 0;

  let tokens = 0;
  for (const part of msg.content) {
    switch (part.type) {
      case "text":
        tokens += estimateStringTokens(part.text);
        break;
      case "tool-call":
        tokens += estimateStringTokens(
          `${part.toolName}:${JSON.stringify(part.input ?? "")}`,
        );
        break;
      case "tool-result":
        tokens += estimateToolResultTokens(part.output);
        break;
      default:
        // reasoning, file, image, etc. — rough estimate from JSON
        tokens += estimateStringTokens(JSON.stringify(part));
        break;
    }
  }
  return tokens;
}

function estimateToolResultTokens(
  output: { type: string; value?: unknown } | undefined,
): number {
  if (!output) return 0;
  if ("value" in output && typeof output.value === "string") {
    return estimateStringTokens(output.value);
  }
  return estimateStringTokens(JSON.stringify(output));
}

// ---------------------------------------------------------------------------
// Compression helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone a message (simple JSON round-trip — sufficient for our data).
 */
function cloneMessage(msg: ModelMessage): ModelMessage {
  return JSON.parse(JSON.stringify(msg));
}

/**
 * Compress large tool-result values in a message array (mutates clones).
 * Returns a new array with compressed messages.
 */
function compressToolResults(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;

    let needsClone = false;
    for (const part of msg.content) {
      if (part.type === "tool-result" && isLargeToolResult(part.output)) {
        needsClone = true;
        break;
      }
    }
    if (!needsClone) return msg;

    const cloned = cloneMessage(msg) as Extract<ModelMessage, { role: "tool" }>;
    for (const part of cloned.content) {
      if (part.type === "tool-result" && isLargeToolResult(part.output)) {
        (part as { output: { type: "text"; value: string } }).output = {
          type: "text",
          value: COMPRESSED_PLACEHOLDER,
        };
      }
    }
    return cloned;
  });
}

function isLargeToolResult(
  output: { type: string; value?: unknown } | undefined,
): boolean {
  if (!output) return false;
  if ("value" in output && typeof output.value === "string") {
    return output.value.length > TOOL_RESULT_COMPRESS_THRESHOLD;
  }
  const serialized = JSON.stringify(output);
  return serialized.length > TOOL_RESULT_COMPRESS_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a ModelMessage array to fit within a token budget.
 *
 * Strategy (in priority order):
 * 1. Compress tool results exceeding 2000 chars
 * 2. Remove early message rounds (from the beginning)
 * 3. Insert a truncation notice at the start
 *
 * Edge cases:
 * - budget <= 0 → use DEFAULT_TOKEN_BUDGET
 * - Single message over budget → truncate its text content
 */
export function truncateToFit(
  messages: ModelMessage[],
  budget?: number,
): TruncationResult {
  const effectiveBudget =
    budget != null && budget > 0 ? budget : DEFAULT_TOKEN_BUDGET;

  if (messages.length === 0) {
    return { messages: [], wasTruncated: false };
  }

  // Check if already within budget
  if (estimateTokens(messages) <= effectiveBudget) {
    return { messages: [...messages], wasTruncated: false };
  }

  // Strategy 1: compress large tool results
  let result = compressToolResults(messages);

  if (estimateTokens(result) <= effectiveBudget) {
    return { messages: result, wasTruncated: false };
  }

  // Strategy 2: remove early messages from the beginning
  const truncated = true;
  while (result.length > 1 && estimateTokens(result) > effectiveBudget) {
    result = result.slice(1);
  }

  // Edge case: single message still over budget → truncate its text
  if (result.length === 1 && estimateTokens(result) > effectiveBudget) {
    result = [truncateSingleMessage(result[0], effectiveBudget)];
  }

  // Strategy 3: insert truncation notice at the beginning
  if (truncated) {
    const notice: ModelMessage = {
      role: "system",
      content: TRUNCATION_NOTICE,
    };
    const noticeTokens = estimateTokens([notice]);

    // Make room for the notice if needed
    while (
      result.length > 1 &&
      estimateTokens(result) + noticeTokens > effectiveBudget
    ) {
      result = result.slice(1);
    }

    // If single message + notice still over budget, truncate the message further
    if (
      result.length === 1 &&
      estimateTokens(result) + noticeTokens > effectiveBudget
    ) {
      const availableBudget = effectiveBudget - noticeTokens;
      if (availableBudget > 0) {
        result = [truncateSingleMessage(result[0], availableBudget)];
      }
    }

    result = [notice, ...result];
  }

  return { messages: result, wasTruncated: truncated };
}

/**
 * Truncate a single message's text content to fit within a token budget.
 */
function truncateSingleMessage(
  msg: ModelMessage,
  budget: number,
): ModelMessage {
  const maxChars = budget * TOKEN_ESTIMATE_RATIO;

  // Only truncate string content for user/system/assistant messages
  if (typeof msg.content === "string" && msg.role !== "tool") {
    return { ...msg, content: msg.content.slice(0, maxChars) } as ModelMessage;
  }

  if (!Array.isArray(msg.content)) return msg;

  const cloned = cloneMessage(msg);
  if (!Array.isArray(cloned.content)) return cloned;

  let remaining = maxChars;
  for (const part of cloned.content) {
    if ("text" in part && typeof part.text === "string") {
      if (part.text.length > remaining) {
        part.text = part.text.slice(0, Math.max(0, remaining));
      }
      remaining -= part.text.length;
    }
    const anyPart = part as Record<string, unknown>;
    if (
      "value" in part &&
      typeof anyPart.value === "string" &&
      anyPart.value.length > remaining
    ) {
      anyPart.value = anyPart.value.slice(0, Math.max(0, remaining));
      remaining -= (anyPart.value as string).length;
    }
  }

  return cloned;
}
