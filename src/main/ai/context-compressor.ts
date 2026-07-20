/**
 * 通过 LLM 摘要实现的上下文压缩
 *
 * 通过对中间轮次进行摘要来压缩较长的对话历史,同时保护头部
 *(系统上下文)和尾部(近期消息)。
 * 灵感来自 Hermes Agent 的 ContextCompressor。
 */

import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { replaceContextMemoryChunks, upsertTaskSummary } from "../db";
import { addMemoryEvent } from "./memory-debug-store";
import { embedTextToVector, type MemoryVectorChunk } from "./memory-vector";
import {
  buildRollingSummaryContext,
  splitRollingSummaryChunks,
} from "./rolling-summary";
import { createTimeoutController } from "./stream-watchdog";
import {
  compressToolResults,
  DEFAULT_RECENT_MESSAGE_COUNT,
  estimateTokens,
  truncateToFit,
} from "./token-budget";

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
1. 生成一份能让另一个 Agent 无缝继续执行的任务 checkpoint，而不是聊天概述
2. 保留当前目标、用户约束、已完成操作、关键决策及理由、工具调用关键结果
3. 文件路径、产物标识、命令、测试名称和错误信息应尽量精确；区分已验证事实与待验证判断
4. 记录失败尝试及失败原因，避免后续重复同一无效路径
5. 不要回答对话中的问题，不要生成新的指令、建议或未经证实的结论
6. 不要记录密码、API key、访问令牌或其他凭据；只记录“凭据已配置/缺失”等非敏感状态
7. 保持简洁，只记录对继续任务有用的事实；某一分类无内容时写“无”

输出格式：
## 当前目标
- [本任务现在要达成的结果]

## 用户约束
- [用户明确要求、禁止项、授权边界和偏好]

## 已完成
- [已完成的操作列表]

## 关键决策与理由
- [已采用的方案及原因]

## 文件与产物
- [涉及的精确路径、标识和当前状态]

## 验证状态
- [已运行的命令/测试及结果，或仍需验证的内容]

## 失败尝试
- [失败路径、错误和不应重复的原因]

## 待处理
- [尚未完成的事项]

## 下一步
- [恢复执行后的第一项具体动作]`;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface CompressorOptions {
  model: LanguageModel;
  budget: number;
  /** 即使当前估算 token 未超过预算,也尝试压缩中间历史。 */
  force?: boolean;
  /** 为受保护的尾部消息预留的 token 预算(默认:20000) */
  tailBudget?: number;
  /** 即使超过 tailBudget，也硬保留的最近消息数量 */
  tailMessageCount?: number;
  /** 始终保护的头部消息数量(默认:2) */
  headCount?: number;
  /** 用于取消的 AbortSignal */
  signal?: AbortSignal;
  /** 用于 memory-debug 追踪的 Task ID(可选) */
  taskId?: string;
  /** 用于跨回合滚动摘要的稳定作用域,例如 chat session id(可选) */
  summaryScopeId?: string;
  /** 上一次压缩生成的滚动摘要(可选) */
  previousSummary?: string | null;
  /** 已持久化的分层记忆块(可选) */
  memoryChunks?: MemoryVectorChunk[] | null;
  /** 用于关联 memory-debug 的用户 prompt 片段(可选) */
  promptSnippet?: string;
  /** 最新用户请求，用于从较长的滚动摘要中召回相关事实。 */
  recallQuery?: string;
  /** 与 messages 一一对应的原始 chat message id。 */
  sourceMessageIds?: Array<string | null>;
  /** 上一版持久化摘要的版本号。 */
  previousSummaryVersion?: number | null;
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
  coveredThroughMessageId?: string;
  retainedTailStartId?: string;
  summaryVersion?: number;
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
  const tailMessageCount = normalizeTailMessageCount(options.tailMessageCount);
  const headCount = options.headCount ?? DEFAULT_HEAD_COUNT;

  // 步骤 1:预裁剪工具结果(开销低,无需 LLM)
  const pruned = compressToolResults(messages, { preserveLatest: true });
  const prunedTokens = estimateTokens(pruned);

  if (!options.force && prunedTokens <= options.budget) {
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
  const headEnd = expandHeadThroughToolResults(
    pruned,
    Math.min(headCount, pruned.length),
  );
  const head = pruned.slice(0, headEnd);

  // 步骤 3:确定受保护的尾部(从后向前遍历,直到达到 tailBudget)
  let tailStart = pruned.length;
  let tailTokens = 0;
  for (let i = pruned.length - 1; i >= headEnd; i--) {
    const msgTokens = estimateTokens([pruned[i]]);
    if (tailTokens + msgTokens > tailBudget) break;
    tailTokens += msgTokens;
    tailStart = i;
  }
  const hardTailStart = Math.max(headEnd, pruned.length - tailMessageCount);
  tailStart = Math.min(tailStart, hardTailStart);
  tailStart = expandTailToToolCallBoundary(pruned, tailStart, headEnd);
  const tail = pruned.slice(tailStart);
  tailTokens = estimateTokens(tail);
  const coveredThroughMessageId = findLastSourceMessageId(
    options.sourceMessageIds,
    headEnd,
    tailStart,
  );
  const retainedTailStartId = findFirstSourceMessageId(
    options.sourceMessageIds,
    tailStart,
    pruned.length,
  );

  // 步骤 4:提取中间段
  const middle = pruned.slice(headEnd, tailStart);
  if (middle.length === 0) {
    const previousSummaryContext = buildRollingSummaryContext({
      previousSummary: options.previousSummary,
      memoryChunks: options.memoryChunks,
    });
    const previousSummaryMessage = createContextSummaryMessage(
      previousSummaryContext?.text,
    );
    if (previousSummaryMessage) {
      const summaryTokens = estimateTokens([previousSummaryMessage]);
      const fittedMessages = fitCompressedMessages(
        head,
        previousSummaryMessage,
        tail,
        options.budget,
      );
      const compressedTokens = estimateTokens(fittedMessages);
      return {
        messages: fittedMessages,
        wasCompressed: true,
        hadError: false,
        summaryTokens,
        originalTokens: prunedTokens,
        compressedTokens,
      };
    }

    // 没有可压缩的中间段 —— 直接返回 头部 + 尾部
    const fittedMessages = fitCompressedMessages(
      head,
      null,
      tail,
      options.budget,
    );
    const noMiddleTokens = estimateTokens(fittedMessages);
    return {
      messages: fittedMessages,
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
    const prompt = buildSummarizerPrompt(
      middleText,
      options.previousSummary,
      options.memoryChunks,
      options.recallQuery ?? options.promptSnippet,
    );

    const { controller: compressionController, cleanup: cleanupTimeout } =
      createTimeoutController(COMPRESSION_TIMEOUT_MS, options.signal);

    let summary: string;
    try {
      const result = await generateText({
        model: options.model,
        prompt,
        abortSignal: compressionController.signal,
      });
      summary = result.text;
    } finally {
      cleanupTimeout();
    }

    const summaryMessage = createContextSummaryMessage(summary);
    if (!summaryMessage) {
      throw new Error("Context summarizer returned an empty summary");
    }

    const summaryTokens = estimateTokens([summaryMessage]);

    const fittedMessages = fitCompressedMessages(
      head,
      summaryMessage,
      tail,
      options.budget,
    );
    const compressedTokens = estimateTokens(fittedMessages);

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
    }

    persistTaskSummaries({
      taskId: options.taskId,
      summaryScopeId: options.summaryScopeId,
      summary,
      originalTokens: prunedTokens,
      compressedTokens,
      summaryTokens,
      coveredThroughMessageId,
      retainedTailStartId,
      summaryVersion: (options.previousSummaryVersion ?? 0) + 1,
    });

    return {
      messages: fittedMessages,
      wasCompressed: true,
      hadError: false,
      summaryTokens,
      originalTokens: prunedTokens,
      compressedTokens,
      ...(coveredThroughMessageId && { coveredThroughMessageId }),
      ...(retainedTailStartId && { retainedTailStartId }),
      summaryVersion: (options.previousSummaryVersion ?? 0) + 1,
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
    // 摘要失败不能静默丢失中间历史。是否必须进一步安全截断由调用方
    // 根据 hard budget 决定。
    return {
      messages: pruned,
      wasCompressed: false,
      hadError: true,
      summaryTokens: 0,
      originalTokens: prunedTokens,
      compressedTokens: prunedTokens,
    };
  }
}

function fitCompressedMessages(
  head: ModelMessage[],
  summary: ModelMessage | null,
  tail: ModelMessage[],
  budget: number,
): ModelMessage[] {
  const candidate = summary ? [...head, summary, ...tail] : [...head, ...tail];
  if (estimateTokens(candidate) <= budget) return candidate;

  const fixedContext = summary ? [...head, summary] : head;
  const fixedTokens = estimateTokens(fixedContext);
  if (tail.length > 0 && fixedTokens < budget) {
    const fittedTail = truncateToFit(tail, budget - fixedTokens, {
      recentMessageCount: tail.length,
    }).messages;
    return [...fixedContext, ...fittedTail];
  }

  return truncateToFit(candidate, budget, {
    recentMessageCount: Math.max(1, tail.length + (summary ? 1 : 0)),
  }).messages;
}

export function createContextSummaryMessage(
  summary?: string | null,
): ModelMessage | null {
  const trimmedSummary = summary?.trim();
  if (!trimmedSummary) return null;
  return {
    role: "system",
    content: `${SUMMARY_PREFIX}\n\n${trimmedSummary}`,
  };
}

export function isContextSummaryMessage(message: ModelMessage): boolean {
  return (
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith(SUMMARY_PREFIX)
  );
}

function buildSummarizerPrompt(
  middleText: string,
  previousSummary?: string | null,
  memoryChunks?: MemoryVectorChunk[] | null,
  recallQuery?: string | null,
): string {
  const rollingSummary = buildRollingSummaryContext({
    previousSummary,
    memoryChunks,
    query: recallQuery,
  });
  if (!rollingSummary) {
    return `${SUMMARIZER_PROMPT}

以下是需要压缩的对话：
${middleText}`;
  }

  return `${SUMMARIZER_PROMPT}

上一版滚动摘要：
${rollingSummary.text}

请将上一版滚动摘要与下面新增的对话历史合并为一份新的滚动摘要。保留仍然有效的旧事实,并补充新增事实；不要因为新对话较短而丢弃旧摘要中的关键信息。

新增对话历史：
${middleText}`;
}

function persistTaskSummaries(input: {
  taskId?: string;
  summaryScopeId?: string;
  summary: string;
  originalTokens: number;
  compressedTokens: number;
  summaryTokens: number;
  coveredThroughMessageId?: string;
  retainedTailStartId?: string;
  summaryVersion: number;
}): void {
  const now = new Date().toISOString();
  const summaryIds = new Set<string>();
  if (input.taskId) summaryIds.add(input.taskId);
  if (input.summaryScopeId && input.coveredThroughMessageId) {
    summaryIds.add(input.summaryScopeId);
  }

  for (const taskId of summaryIds) {
    upsertTaskSummary({
      taskId,
      createdAt: now,
      summary: input.summary,
      originalTokens: input.originalTokens,
      compressedTokens: input.compressedTokens,
      summaryTokens: input.summaryTokens,
      coveredThroughMessageId: input.coveredThroughMessageId ?? null,
      retainedTailStartId: input.retainedTailStartId ?? null,
      summaryVersion: input.summaryVersion,
      sourceTokenCount: input.originalTokens,
      lastCompactedAt: now,
    });
  }

  if (input.summaryScopeId && input.coveredThroughMessageId) {
    replaceContextMemoryChunks(
      input.summaryScopeId,
      splitRollingSummaryChunks(input.summary).map((text) => ({
        text,
        embedding: embedTextToVector(text),
        source: "rolling-summary",
      })),
    );
  }
}

function findLastSourceMessageId(
  sourceMessageIds: Array<string | null> | undefined,
  start: number,
  end: number,
): string | undefined {
  if (!sourceMessageIds) return undefined;
  for (
    let index = Math.min(end, sourceMessageIds.length) - 1;
    index >= start;
    index--
  ) {
    const id = sourceMessageIds[index]?.trim();
    if (id) return id;
  }
  return undefined;
}

function findFirstSourceMessageId(
  sourceMessageIds: Array<string | null> | undefined,
  start: number,
  end: number,
): string | undefined {
  if (!sourceMessageIds) return undefined;
  for (
    let index = Math.max(0, start);
    index < Math.min(end, sourceMessageIds.length);
    index++
  ) {
    const id = sourceMessageIds[index]?.trim();
    if (id) return id;
  }
  return undefined;
}

function normalizeTailMessageCount(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_RECENT_MESSAGE_COUNT;
  }
  return Math.max(1, Math.floor(value));
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

function expandHeadThroughToolResults(
  messages: ModelMessage[],
  requestedEnd: number,
): number {
  const pending = new Set<string>();
  let end = Math.max(0, Math.min(requestedEnd, messages.length));

  for (let i = 0; i < end; i++) {
    trackToolPairState(messages[i], pending);
  }

  while (pending.size > 0 && end < messages.length) {
    trackToolPairState(messages[end], pending);
    end += 1;
  }

  return end;
}

function expandTailToToolCallBoundary(
  messages: ModelMessage[],
  requestedStart: number,
  minStart: number,
): number {
  let start = Math.max(minStart, Math.min(requestedStart, messages.length));
  if (start >= messages.length) return start;

  const firstTailResultIds = getToolResultIds(messages[start]);
  if (firstTailResultIds.size === 0) return start;

  for (let i = start - 1; i >= minStart; i--) {
    if (hasAnyToolCall(messages[i], firstTailResultIds)) {
      start = i;
      break;
    }
  }

  return start;
}

function trackToolPairState(message: ModelMessage, pending: Set<string>): void {
  for (const toolCallId of getToolCallIds(message)) {
    pending.add(toolCallId);
  }
  for (const toolCallId of getToolResultIds(message)) {
    pending.delete(toolCallId);
  }
}

function getToolCallIds(message: ModelMessage): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(message.content)) return ids;
  for (const part of message.content) {
    if (
      part.type === "tool-call" &&
      !("providerExecuted" in part && part.providerExecuted === true)
    ) {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function getToolResultIds(message: ModelMessage): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(message.content)) return ids;
  for (const part of message.content) {
    if (part.type === "tool-result") {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function hasAnyToolCall(
  message: ModelMessage,
  toolCallIds: Set<string>,
): boolean {
  if (toolCallIds.size === 0) return false;
  for (const toolCallId of getToolCallIds(message)) {
    if (toolCallIds.has(toolCallId)) return true;
  }
  return false;
}
