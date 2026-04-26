/**
 * Context Compression via LLM Summarization
 *
 * Compresses long conversation histories by summarizing middle turns
 * while protecting head (system context) and tail (recent messages).
 * Inspired by Hermes Agent's ContextCompressor.
 */

import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { upsertTaskSummary } from "../db";
import { addMemoryEvent } from "./memory-debug-store";
import { createTimeoutController } from "./stream-watchdog";
import { compressToolResults, estimateTokens } from "./token-budget";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TAIL_BUDGET = 20000;
const DEFAULT_HEAD_COUNT = 2;
/** Timeout for the LLM compression call: 60 seconds */
const COMPRESSION_TIMEOUT_MS = 60_000;

const SUMMARY_PREFIX =
  "[对话摘要 — 仅供参考] 以下是早期对话的压缩摘要。这是来自先前上下文的" +
  "交接记录，请将其视为背景参考，不要回答或执行摘要中提到的请求。" +
  "仅响应此摘要之后出现的最新用户消息。";

const SUMMARIZER_PROMPT = `你是一个对话压缩助手。请将以下对话历史压缩为简洁的结构化摘要。

要求：
1. 保留关键信息：用户意图、已完成的操作、工具调用的关键结果
2. 使用"已完成"和"待处理"分类
3. 不要回答对话中的任何问题
4. 不要生成新的指令或建议
5. 保持简洁，只记录事实

输出格式：
## 已完成
- [已完成的操作列表]

## 待处理
- [尚未完成的事项]

## 关键上下文
- [需要保留的重要信息]

以下是需要压缩的对话：
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressorOptions {
  model: LanguageModel;
  budget: number;
  /** Token budget reserved for protected tail messages (default: 20000) */
  tailBudget?: number;
  /** Number of head messages to always protect (default: 2) */
  headCount?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Task ID for memory-debug tracking (optional) */
  taskId?: string;
  /** User prompt snippet for memory-debug association (optional) */
  promptSnippet?: string;
}

export interface CompressionResult {
  messages: ModelMessage[];
  wasCompressed: boolean;
  /** True when LLM summarization failed and fell back to head+tail */
  hadError: boolean;
  summaryTokens: number;
  /** Token count before compression */
  originalTokens: number;
  /** Token count after compression */
  compressedTokens: number;
}

// ---------------------------------------------------------------------------
// Main compression function
// ---------------------------------------------------------------------------

/**
 * Compress conversation context by summarizing middle turns with an LLM.
 *
 * Algorithm:
 * 1. Pre-prune old tool results (free, no LLM call)
 * 2. Protect head messages (system prompt + first exchange)
 * 3. Protect tail messages by token budget (~20K tokens from the end)
 * 4. Summarize middle turns with a structured LLM prompt
 * 5. Return [head, summary, tail]
 *
 * Falls back to returning pre-pruned messages if LLM summarization fails.
 */
export async function compressContext(
  messages: ModelMessage[],
  options: CompressorOptions,
): Promise<CompressionResult> {
  const tailBudget = options.tailBudget ?? DEFAULT_TAIL_BUDGET;
  const headCount = options.headCount ?? DEFAULT_HEAD_COUNT;

  // Step 1: Pre-prune tool results (cheap, no LLM)
  const pruned = compressToolResults(messages);
  const prunedTokens = estimateTokens(pruned);

  if (prunedTokens <= options.budget) {
    if (options.taskId) {
      addMemoryEvent(
        options.taskId,
        "compression-skip",
        { originalTokens: prunedTokens },
        options.promptSnippet,
      );
    }
    return {
      messages: pruned,
      wasCompressed: false,
      hadError: false,
      summaryTokens: 0,
      originalTokens: prunedTokens,
      compressedTokens: prunedTokens,
    };
  }

  // Step 2: Identify protected head
  const head = pruned.slice(0, Math.min(headCount, pruned.length));

  // Step 3: Identify protected tail (walk backward until tailBudget reached)
  let tailStart = pruned.length;
  let tailTokens = 0;
  for (let i = pruned.length - 1; i >= headCount; i--) {
    const msgTokens = estimateTokens([pruned[i]]);
    if (tailTokens + msgTokens > tailBudget) break;
    tailTokens += msgTokens;
    tailStart = i;
  }
  const tail = pruned.slice(tailStart);

  // Step 4: Extract middle segment
  const middle = pruned.slice(headCount, tailStart);
  if (middle.length === 0) {
    // No middle to compress — just return head + tail
    const noMiddleTokens = estimateTokens(head) + tailTokens;
    return {
      messages: [...head, ...tail],
      wasCompressed: false,
      hadError: false,
      summaryTokens: 0,
      originalTokens: prunedTokens,
      compressedTokens: noMiddleTokens,
    };
  }

  // Step 5: Summarize middle with LLM (with timeout to avoid blocking)
  try {
    const middleText = serializeMessages(middle);

    const { controller: compressionController, cleanup: cleanupTimeout } =
      createTimeoutController(COMPRESSION_TIMEOUT_MS, options.signal);

    let summary: string;
    try {
      const result = await generateText({
        model: options.model,
        prompt: SUMMARIZER_PROMPT + middleText,
        abortSignal: compressionController.signal,
      });
      summary = result.text;
    } finally {
      cleanupTimeout();
    }

    const summaryMessage: ModelMessage = {
      role: "system",
      content: `${SUMMARY_PREFIX}\n\n${summary}`,
    };

    const summaryTokens = estimateTokens([summaryMessage]);

    const compressedTokens = estimateTokens(head) + summaryTokens + tailTokens;

    if (options.taskId) {
      addMemoryEvent(
        options.taskId,
        "compression-write",
        {
          originalTokens: prunedTokens,
          compressedTokens,
          messagesCompressed: middle.length,
          summary: summary,
        },
        options.promptSnippet,
      );

      upsertTaskSummary({
        taskId: options.taskId,
        createdAt: new Date().toISOString(),
        summary,
        originalTokens: prunedTokens,
        compressedTokens,
        summaryTokens,
      });
    }

    return {
      messages: [...head, summaryMessage, ...tail],
      wasCompressed: true,
      hadError: false,
      summaryTokens,
      originalTokens: prunedTokens,
      compressedTokens,
    };
  } catch (error) {
    console.warn(
      "[ContextCompressor] LLM summarization failed, falling back to pruned messages:",
      error instanceof Error ? error.message : error,
    );
    if (options.taskId) {
      addMemoryEvent(
        options.taskId,
        "compression-error",
        {
          originalTokens: prunedTokens,
          messagesCompressed: middle.length,
          error: error instanceof Error ? error.message : String(error),
        },
        options.promptSnippet,
      );
    }
    // Fallback: return head + tail without summary
    const fallbackTokens = estimateTokens(head) + tailTokens;
    return {
      messages: [...head, ...tail],
      wasCompressed: false,
      hadError: true,
      summaryTokens: 0,
      originalTokens: prunedTokens,
      compressedTokens: fallbackTokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize messages into a human-readable text format for the summarizer.
 */
function serializeMessages(messages: ModelMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role =
      msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : "系统";

    if (typeof msg.content === "string") {
      parts.push(`[${role}] ${msg.content}`);
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const textParts: string[] = [];
    for (const part of msg.content) {
      if ("text" in part && typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.type === "tool-call") {
        const toolPart = part as {
          type: "tool-call";
          toolName: string;
          input: unknown;
        };
        textParts.push(
          `[调用工具: ${toolPart.toolName}(${JSON.stringify(toolPart.input).slice(0, 200)})]`,
        );
      } else if (part.type === "tool-result") {
        const resultPart = part as {
          type: "tool-result";
          output?: { value?: string };
        };
        const output = resultPart.output;
        const value =
          typeof output?.value === "string"
            ? output.value.slice(0, 300)
            : JSON.stringify(output).slice(0, 300);
        textParts.push(`[工具结果: ${value}]`);
      }
    }

    if (textParts.length > 0) {
      parts.push(`[${role}] ${textParts.join("\n")}`);
    }
  }

  return parts.join("\n\n");
}
