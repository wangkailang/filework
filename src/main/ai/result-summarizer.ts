/**
 * Large Tool Result Summarization
 *
 * When tool results exceed a size threshold (default 60KB), uses a lightweight
 * LLM call to generate a concise summary instead of simple truncation.
 * This preserves semantic information while dramatically reducing token usage.
 *
 * Inspired by Craft Agents' response compression pattern.
 */

import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { addMemoryEvent } from "./memory-debug-store";
import { createTimeoutController } from "./stream-watchdog";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold in characters above which LLM summarization kicks in */
const SUMMARIZE_THRESHOLD = 60_000;
/** Timeout for each summarization call */
const SUMMARIZE_TIMEOUT_MS = 30_000;
/** Max input chars sent to the summarizer (avoid feeding 1MB+ to a small model) */
const MAX_SUMMARIZE_INPUT = 200_000;

const SUMMARIZE_PROMPT = `你是一个工具结果摘要助手。请将以下工具执行结果压缩为简洁的结构化摘要。

要求：
1. 保留关键数据和结论
2. 保留重要的文件路径、数字、状态值
3. 省略重复条目，用数量描述替代（例："共 42 个文件"）
4. 如果是文件列表，只保留前几项和统计信息
5. 如果是错误信息，完整保留错误原因
6. 保持简洁，通常不超过 500 字

以下是需要摘要的工具结果：
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SummarizeOptions {
  model: LanguageModel;
  signal?: AbortSignal;
  /** Task ID for memory-debug tracking */
  taskId?: string;
  /** User prompt snippet for memory-debug association */
  promptSnippet?: string;
}

/**
 * Process a message array and summarize any tool results exceeding the
 * size threshold. Returns a new array — original messages are not mutated.
 *
 * Tool results below the threshold are left as-is (the existing sync
 * `compressToolResults` handles the 2KB–60KB range with placeholder
 * replacement).
 */
export async function summarizeLargeToolResults(
  messages: ModelMessage[],
  opts: SummarizeOptions,
): Promise<ModelMessage[]> {
  const results: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) {
      results.push(msg);
      continue;
    }

    let hasLarge = false;
    for (const part of msg.content) {
      if (part.type === "tool-result" && isVeryLarge(part.output)) {
        hasLarge = true;
        break;
      }
    }

    if (!hasLarge) {
      results.push(msg);
      continue;
    }

    // Clone and summarize large parts
    const cloned = JSON.parse(JSON.stringify(msg)) as Extract<
      ModelMessage,
      { role: "tool" }
    >;
    let summarizedCount = 0;
    for (const part of cloned.content) {
      if (part.type === "tool-result" && isVeryLarge(part.output)) {
        const raw = extractText(part.output);
        try {
          const summary = await summarizeText(raw, opts);
          (part as { output: { type: "text"; value: string } }).output = {
            type: "text",
            value: `[工具结果摘要] ${summary}`,
          };
          summarizedCount++;
        } catch (err) {
          console.warn(
            "[result-summarizer] LLM summarization failed, using truncation fallback:",
            err instanceof Error ? err.message : err,
          );
          (part as { output: { type: "text"; value: string } }).output = {
            type: "text",
            value: `[工具结果已截断] ${raw.slice(0, 2000)}...`,
          };
        }
      }
    }
    if (summarizedCount > 0 && opts.taskId) {
      addMemoryEvent(
        opts.taskId,
        "result-summarize",
        { resultsSummarized: summarizedCount },
        opts.promptSnippet,
      );
    }
    results.push(cloned);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isVeryLarge(
  output: { type: string; value?: unknown } | undefined,
): boolean {
  if (!output) return false;
  const text = extractText(output);
  return text.length > SUMMARIZE_THRESHOLD;
}

function extractText(output: { type: string; value?: unknown }): string {
  if ("value" in output && typeof output.value === "string") {
    return output.value;
  }
  return JSON.stringify(output);
}

async function summarizeText(
  text: string,
  opts: SummarizeOptions,
): Promise<string> {
  const input =
    text.length > MAX_SUMMARIZE_INPUT
      ? `${text.slice(0, MAX_SUMMARIZE_INPUT)}\n\n[...truncated, total ${text.length} chars]`
      : text;

  const { controller, cleanup } = createTimeoutController(
    SUMMARIZE_TIMEOUT_MS,
    opts.signal,
  );

  try {
    const result = await generateText({
      model: opts.model,
      prompt: SUMMARIZE_PROMPT + input,
      abortSignal: controller.signal,
    });
    return result.text;
  } finally {
    cleanup();
  }
}
