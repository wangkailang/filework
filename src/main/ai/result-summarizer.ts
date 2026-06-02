/**
 * 大体积工具结果摘要
 *
 * 当工具结果超过尺寸阈值(默认 60KB)时,使用一次轻量级 LLM 调用生成简洁摘要,
 * 而非简单截断。这样可在大幅降低 token 用量的同时保留语义信息。
 *
 * 灵感来自 Craft Agents 的响应压缩模式。
 */

import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { addMemoryEvent } from "./memory-debug-store";
import { createTimeoutController } from "./stream-watchdog";
import { TOOL_RESULT_COMPRESS_THRESHOLD_CHARS } from "./token-budget";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 超过该字符数阈值即触发 LLM 摘要 */
const SUMMARIZE_THRESHOLD = 60_000;
/** 单次摘要调用的超时时间 */
const SUMMARIZE_TIMEOUT_MS = 30_000;
/** 发送给摘要器的最大输入字符数(避免把 1MB+ 喂给小模型) */
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
// 公开 API
// ---------------------------------------------------------------------------

export interface SummarizeOptions {
  model: LanguageModel;
  signal?: AbortSignal;
  /** 用于 memory-debug 追踪的任务 ID */
  taskId?: string;
  /** 用于关联 memory-debug 的用户 prompt 片段 */
  promptSnippet?: string;
}

/**
 * 处理消息数组,并对任何超过尺寸阈值的工具结果进行摘要。返回一个新数组 ——
 * 原始消息不会被修改。
 *
 * 低于阈值的工具结果原样保留(已有的同步 `compressToolResults` 以占位符替换的
 * 方式处理 2KB–60KB 区间)。
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

    // 克隆并对大体积分片进行摘要
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
            value: `[工具结果已截断] ${raw.slice(0, TOOL_RESULT_COMPRESS_THRESHOLD_CHARS)}...`,
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
// 内部辅助函数
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
