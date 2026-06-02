/**
 * 通过 LLM 摘要实现的上下文压缩
 *
 * 通过对中间轮次进行摘要来压缩较长的对话历史,同时保护头部
 *(系统上下文)和尾部(近期消息)。
 * 灵感来自 Hermes Agent 的 ContextCompressor。
 */

import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { upsertTaskSummary } from "../db";
import { addMemoryEvent } from "./memory-debug-store";
import { createTimeoutController } from "./stream-watchdog";
import { compressToolResults, estimateTokens } from "./token-budget";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_TAIL_BUDGET = 20000;
const DEFAULT_HEAD_COUNT = 2;
/** LLM 压缩调用的超时时间:60 秒 */
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
// 类型
// ---------------------------------------------------------------------------

export interface CompressorOptions {
  model: LanguageModel;
  budget: number;
  /** 为受保护的尾部消息预留的 token 预算(默认:20000) */
  tailBudget?: number;
  /** 始终保护的头部消息数量(默认:2) */
  headCount?: number;
  /** 用于取消的 AbortSignal */
  signal?: AbortSignal;
  /** 用于 memory-debug 追踪的 Task ID(可选) */
  taskId?: string;
  /** 用于关联 memory-debug 的用户 prompt 片段(可选) */
  promptSnippet?: string;
}

export interface CompressionResult {
  messages: ModelMessage[];
  wasCompressed: boolean;
  /** 当 LLM 摘要失败并回退到 头部+尾部 时为 true */
  hadError: boolean;
  summaryTokens: number;
  /** 压缩前的 token 数 */
  originalTokens: number;
  /** 压缩后的 token 数 */
  compressedTokens: number;
}

// ---------------------------------------------------------------------------
// 主压缩函数
// ---------------------------------------------------------------------------

/**
 * 通过 LLM 对中间轮次进行摘要来压缩对话上下文。
 *
 * 算法:
 * 1. 预先裁剪旧的工具结果(免费,无需调用 LLM)
 * 2. 保护头部消息(系统 prompt + 首次交互)
 * 3. 按 token 预算保护尾部消息(从末尾算起约 20K tokens)
 * 4. 用结构化的 LLM prompt 对中间轮次进行摘要
 * 5. 返回 [头部, 摘要, 尾部]
 *
 * 若 LLM 摘要失败,则回退为返回预裁剪后的消息。
 */
export async function compressContext(
  messages: ModelMessage[],
  options: CompressorOptions,
): Promise<CompressionResult> {
  const tailBudget = options.tailBudget ?? DEFAULT_TAIL_BUDGET;
  const headCount = options.headCount ?? DEFAULT_HEAD_COUNT;

  // 步骤 1:预裁剪工具结果(开销低,无需 LLM)
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

  // 步骤 2:确定受保护的头部
  const head = pruned.slice(0, Math.min(headCount, pruned.length));

  // 步骤 3:确定受保护的尾部(从后向前遍历,直到达到 tailBudget)
  let tailStart = pruned.length;
  let tailTokens = 0;
  for (let i = pruned.length - 1; i >= headCount; i--) {
    const msgTokens = estimateTokens([pruned[i]]);
    if (tailTokens + msgTokens > tailBudget) break;
    tailTokens += msgTokens;
    tailStart = i;
  }
  const tail = pruned.slice(tailStart);

  // 步骤 4:提取中间段
  const middle = pruned.slice(headCount, tailStart);
  if (middle.length === 0) {
    // 没有可压缩的中间段 —— 直接返回 头部 + 尾部
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

  // 步骤 5:用 LLM 对中间段进行摘要(带超时以避免阻塞)
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
    // 回退:返回不含摘要的 头部 + 尾部
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
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 将消息序列化为人类可读的文本格式,供摘要器使用。
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
