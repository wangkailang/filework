import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TOKEN_BUDGET = 80_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const SAFETY_MARGIN = 2_000;
export const TOOL_RESULT_COMPRESS_THRESHOLD_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Model context window map
// ---------------------------------------------------------------------------

/**
 * Known context window sizes (in tokens) for common models.
 * Prefix-matched: "claude-3.5-sonnet-20241022" matches "claude-3.5-sonnet".
 * More specific prefixes should come first.
 */
const MODEL_CONTEXT_WINDOWS: [prefix: string, tokens: number][] = [
  // Anthropic
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-3.7", 200_000],
  ["claude-3.5-sonnet", 200_000],
  ["claude-3.5-haiku", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-3-sonnet", 200_000],
  ["claude-3-haiku", 200_000],
  ["claude", 200_000],
  // OpenAI
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4-0125", 128_000],
  ["gpt-4-1106", 128_000],
  ["gpt-4", 8_192],
  ["gpt-3.5-turbo", 16_385],
  ["o4-mini", 200_000],
  ["o3", 200_000],
  ["o3-mini", 200_000],
  ["o1", 200_000],
  ["o1-mini", 128_000],
  // DeepSeek
  ["deepseek-chat", 64_000],
  ["deepseek-coder", 64_000],
  ["deepseek-reasoner", 64_000],
  ["deepseek", 64_000],
];

/**
 * Compute the input token budget for a given model.
 *
 * Formula: contextWindow - maxOutputTokens - safetyMargin
 * Falls back to DEFAULT_TOKEN_BUDGET for unknown models.
 */
export function getTokenBudgetForModel(modelId: string): number {
  const lower = modelId.toLowerCase();
  for (const [prefix, contextWindow] of MODEL_CONTEXT_WINDOWS) {
    if (lower.startsWith(prefix)) {
      return contextWindow - DEFAULT_MAX_OUTPUT_TOKENS - SAFETY_MARGIN;
    }
  }
  return DEFAULT_TOKEN_BUDGET;
}
const TRUNCATION_NOTICE =
  "[系统提示] 部分早期对话已被省略，以下为最近的对话内容。";
const COMPRESSED_PLACEHOLDER = "[工具结果已压缩]";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TruncationResult {
  messages: ModelMessage[];
  wasTruncated: boolean;
  /** Number of messages dropped by simple truncation (0 if not truncated) */
  messagesDropped: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

// CJK Unified Ideographs and common CJK ranges (global flag for matchAll)
const CJK_RE_G =
  /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u{20000}-\u{2FA1F}]/gu;

/**
 * Estimate the token count of a single string.
 *
 * Latin/ASCII text: ~4 chars per token (GPT/Claude average).
 * CJK text: ~1.5 chars per token — each character is typically 1-2 tokens
 * in common tokenizers (cl100k, claude).
 *
 * Uses a single global regex match to count CJK characters, avoiding
 * per-character iteration overhead on large strings (tool results up to 200KB).
 */
function estimateStringTokens(text: string): number {
  CJK_RE_G.lastIndex = 0;
  const cjkChars = text.match(CJK_RE_G)?.length ?? 0;
  const latinChars = text.length - cjkChars;
  // CJK: ~1.5 chars/token  |  Latin/ASCII: ~4 chars/token
  return Math.ceil(cjkChars / 1.5 + latinChars / 4);
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

/**
 * Per-attachment token approximations. Picking conservative defaults
 * keeps the budget from over-firing compression on routine submits
 * while staying in the right order of magnitude. Anthropic's image
 * tokenizer maxes around ~1500 tokens; PDFs depend on length but
 * ~2000 tokens covers a short doc.
 *
 * Crucially: never `JSON.stringify` an image/file part — its `image`
 * or `data` field is a Buffer, and stringifying expands it to a giant
 * `{type:"Buffer",data:[...]}` literal that both bloats the estimate
 * and (downstream) gets parsed back as a plain object, killing the
 * Buffer identity that the AI SDK schema requires.
 */
const IMAGE_TOKEN_APPROX = 1500;
const FILE_TOKEN_APPROX = 2000;

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
      case "image":
        tokens += IMAGE_TOKEN_APPROX;
        break;
      case "file":
        tokens += FILE_TOKEN_APPROX;
        break;
      default:
        // reasoning and other rare parts — rough estimate from JSON.
        // Safe here because these don't carry binary fields.
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
export function compressToolResults(messages: ModelMessage[]): ModelMessage[] {
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
    return output.value.length > TOOL_RESULT_COMPRESS_THRESHOLD_CHARS;
  }
  const serialized = JSON.stringify(output);
  return serialized.length > TOOL_RESULT_COMPRESS_THRESHOLD_CHARS;
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
    return { messages: [], wasTruncated: false, messagesDropped: 0 };
  }

  // Check if already within budget
  if (estimateTokens(messages) <= effectiveBudget) {
    return { messages: [...messages], wasTruncated: false, messagesDropped: 0 };
  }

  // Strategy 1: compress large tool results
  let result = compressToolResults(messages);

  if (estimateTokens(result) <= effectiveBudget) {
    return { messages: result, wasTruncated: false, messagesDropped: 0 };
  }

  // Strategy 2: remove early messages from the beginning
  const originalCount = result.length;
  while (result.length > 1 && estimateTokens(result) > effectiveBudget) {
    result = result.slice(1);
  }

  // Edge case: single message still over budget → truncate its text
  if (result.length === 1 && estimateTokens(result) > effectiveBudget) {
    result = [truncateSingleMessage(result[0], effectiveBudget)];
  }

  // Strategy 3: insert truncation notice at the beginning
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
  // Subtract 1 for the notice message we added
  const messagesDropped = originalCount - (result.length - 1);

  return { messages: result, wasTruncated: true, messagesDropped };
}

/**
 * Truncate a single message's text content to fit within a token budget.
 * Uses the CJK ratio (1.5 chars/token) as a conservative estimate so we
 * never exceed the budget regardless of script.
 *
 * IMPORTANT: do NOT use `cloneMessage` (JSON-roundtrip) here when the
 * content array contains binary parts (image/file). Buffer fields would
 * be serialized to `{type:"Buffer",data:[...]}` plain objects, breaking
 * the AI SDK's `instanceof Uint8Array` check and rejecting the prompt.
 * Instead we do a shallow array copy and recreate only the text parts
 * that need slicing — binary parts pass through by reference.
 */
function truncateSingleMessage(
  msg: ModelMessage,
  budget: number,
): ModelMessage {
  const maxChars = Math.floor(budget * 1.5);

  // Only truncate string content for user/system/assistant messages
  if (typeof msg.content === "string" && msg.role !== "tool") {
    return { ...msg, content: msg.content.slice(0, maxChars) } as ModelMessage;
  }

  if (!Array.isArray(msg.content)) return msg;

  // Shallow clone: preserve binary part references; only mutate string
  // fields via new objects so we don't mutate the caller's array.
  const cloned = {
    ...msg,
    content: msg.content.map((p) => ({ ...p })),
  } as ModelMessage;
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

// ---------------------------------------------------------------------------
// Async truncation with optional LLM compression
// ---------------------------------------------------------------------------

export interface CompressionResult {
  messages: ModelMessage[];
  wasCompressed: boolean;
}

/**
 * Async version of truncateToFit that supports an optional LLM compressor.
 *
 * If simple truncation exceeds the budget and a compressor is provided,
 * delegates to the compressor. Falls back to simple truncation on failure.
 */
export async function truncateToFitAsync(
  messages: ModelMessage[],
  budget?: number,
  compressor?: (
    msgs: ModelMessage[],
    budget: number,
  ) => Promise<CompressionResult>,
): Promise<TruncationResult> {
  const effectiveBudget =
    budget != null && budget > 0 ? budget : DEFAULT_TOKEN_BUDGET;

  if (messages.length === 0) {
    return { messages: [], wasTruncated: false, messagesDropped: 0 };
  }

  // Check if already within budget
  if (estimateTokens(messages) <= effectiveBudget) {
    return { messages: [...messages], wasTruncated: false, messagesDropped: 0 };
  }

  // Strategy 1: compress tool results
  const compressed = compressToolResults(messages);
  if (estimateTokens(compressed) <= effectiveBudget) {
    return { messages: compressed, wasTruncated: false, messagesDropped: 0 };
  }

  // Strategy 2: try LLM compression if available
  if (compressor) {
    try {
      const result = await compressor(compressed, effectiveBudget);
      if (estimateTokens(result.messages) <= effectiveBudget) {
        return {
          messages: result.messages,
          wasTruncated: result.wasCompressed,
          messagesDropped: 0,
        };
      }
    } catch (err) {
      console.warn(
        "[token-budget] LLM compression failed, falling back to simple truncation:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Strategy 3: fall back to simple drop-from-beginning
  return truncateToFit(compressed, budget);
}
