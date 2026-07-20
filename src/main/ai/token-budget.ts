import type { ModelMessage } from "ai";
import { getContextWindowForModelId } from "../../shared/model-context-window";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const DEFAULT_TOKEN_BUDGET = 80_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const SAFETY_MARGIN = 2_000;
export const TOOL_RESULT_COMPRESS_THRESHOLD_CHARS = 2_000;
export const COMPRESSION_TRIGGER_RATIO = 0.85;
export const COMPRESSION_TARGET_RATIO = 0.5;
export const DEFAULT_RECENT_MESSAGE_COUNT = 6;
export const CONTEXT_GROWTH_RESERVE_RATIO = 0.1;
export const MAX_CONTEXT_GROWTH_RESERVE_TOKENS = 32_768;

// ---------------------------------------------------------------------------
// 模型上下文预算
// ---------------------------------------------------------------------------

/**
 * 计算给定模型的输入 token 预算。
 *
 * 公式：contextWindow - maxOutputTokens - safetyMargin
 * 对未知模型回退到 DEFAULT_TOKEN_BUDGET。
 */
export function getTokenBudgetForModel(modelId: string): number {
  const contextWindow = getContextWindowForModel(modelId);
  return contextWindow != null
    ? contextWindow - DEFAULT_MAX_OUTPUT_TOKENS - SAFETY_MARGIN
    : DEFAULT_TOKEN_BUDGET;
}

export function getContextWindowForModel(modelId: string): number | null {
  return getContextWindowForModelId(modelId);
}

export function getTokenBudget(input: {
  modelId?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}): number {
  if (
    input.contextWindow != null &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
  ) {
    const maxOutputTokens =
      input.maxOutputTokens != null &&
      Number.isFinite(input.maxOutputTokens) &&
      input.maxOutputTokens > 0
        ? input.maxOutputTokens
        : DEFAULT_MAX_OUTPUT_TOKENS;
    return Math.max(
      1,
      Math.floor(input.contextWindow - maxOutputTokens - SAFETY_MARGIN),
    );
  }

  return input.modelId
    ? getTokenBudgetForModel(input.modelId)
    : DEFAULT_TOKEN_BUDGET;
}

export function getCompressionTriggerBudget(input: {
  modelId?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}): number {
  const hardBudget = getTokenBudget(input);
  const contextWindow =
    input.contextWindow != null &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? input.contextWindow
      : input.modelId
        ? getContextWindowForModel(input.modelId)
        : null;
  const triggerBudget =
    contextWindow != null
      ? Math.floor(contextWindow * COMPRESSION_TRIGGER_RATIO)
      : Math.floor(hardBudget * COMPRESSION_TRIGGER_RATIO);
  const growthReserve = Math.min(
    MAX_CONTEXT_GROWTH_RESERVE_TOKENS,
    Math.floor((contextWindow ?? hardBudget) * CONTEXT_GROWTH_RESERVE_RATIO),
  );
  const headroomBudget = hardBudget - growthReserve;
  return Math.max(1, Math.min(hardBudget, triggerBudget, headroomBudget));
}

export function getCompressionTargetBudget(input: {
  modelId?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}): number {
  const hardBudget = getTokenBudget(input);
  const contextWindow =
    input.contextWindow != null &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? input.contextWindow
      : input.modelId
        ? getContextWindowForModel(input.modelId)
        : null;
  const targetBudget = Math.floor(
    (contextWindow ?? hardBudget) * COMPRESSION_TARGET_RATIO,
  );
  return Math.max(1, Math.min(hardBudget, targetBudget));
}
const TRUNCATION_NOTICE =
  "[系统提示] 部分早期对话已被省略，以下为最近的对话内容。";
const COMPRESSED_PLACEHOLDER = "[工具结果已压缩]";

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

export interface TruncationResult {
  messages: ModelMessage[];
  wasTruncated: boolean;
  compressionStage:
    | "none"
    | "tool-result-compaction"
    | "llm-summary"
    | "safe-truncation";
  /** 简单截断丢弃的消息数量（未截断时为 0） */
  messagesDropped: number;
  /**
   * 本地工具结果压缩的 token 变化。该路径无需 LLM 摘要,但仍会改变实际
   * 发送上下文,调用方可据此暴露一次明确的 compression 事件。
   */
  toolResultCompaction?: {
    originalTokens: number;
    compressedTokens: number;
  };
}

export interface TruncationOptions {
  /** 最近 N 条 chat 消息硬保留；预算极紧时只裁剪消息文本，不整条丢弃。 */
  recentMessageCount?: number;
}

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

// CJK 统一表意文字及常见 CJK 区段（带 global 标志以供 matchAll 使用）
const CJK_RE_G =
  /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u{20000}-\u{2FA1F}]/gu;

/**
 * 估算单个字符串的 token 数量。
 *
 * 拉丁/ASCII 文本：约 4 字符/token（GPT/Claude 平均值）。
 * CJK 文本：约 1.5 字符/token —— 在常见分词器（cl100k、claude）中
 * 每个字符通常为 1-2 个 token。
 *
 * 使用单次全局正则匹配统计 CJK 字符，避免在大字符串（工具结果可达 200KB）
 * 上逐字符迭代的开销。
 */
function estimateStringTokens(text: string): number {
  CJK_RE_G.lastIndex = 0;
  const cjkChars = text.match(CJK_RE_G)?.length ?? 0;
  const latinChars = text.length - cjkChars;
  // CJK：约 1.5 字符/token  |  拉丁/ASCII：约 4 字符/token
  return Math.ceil(cjkChars / 1.5 + latinChars / 4);
}

/**
 * 估算 ModelMessage 数组的总 token 数量。
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * 各类附件的 token 近似值。选取保守的默认值，既能在数量级上保持准确，
 * 又能避免在日常提交时过度触发压缩。Anthropic 的图片分词器上限约为
 * 1500 token；PDF 取决于长度，但约 2000 token 足以覆盖一份短文档。
 *
 * 关键点：绝不要对 image/file 分块执行 `JSON.stringify` —— 其 `image`
 * 或 `data` 字段是 Buffer，序列化会将其展开为一个巨大的
 * `{type:"Buffer",data:[...]}` 字面量，既会膨胀估算值，又会（在下游）
 * 被解析回普通对象，破坏 AI SDK schema 所要求的 Buffer 身份。
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
        // reasoning 及其他罕见分块 —— 用 JSON 做粗略估算。
        // 此处安全，因为这些分块不携带二进制字段。
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
// 压缩辅助函数
// ---------------------------------------------------------------------------

/**
 * 深拷贝一条消息。使用 Node 的 `structuredClone`，使二进制字段
 * （`image: Uint8Array`、`data: Buffer`）在往返过程中原型保持完整 ——
 * AI SDK 的 prompt schema 会检查 `instanceof Uint8Array`，而 JSON 往返
 * 会悄无声息地破坏它。
 */
function cloneMessage(msg: ModelMessage): ModelMessage {
  return structuredClone(msg);
}

/**
 * 压缩消息数组中过大的 tool-result 值（对克隆副本进行变更）。
 * 返回包含已压缩消息的新数组。
 */
export function compressToolResults(
  messages: ModelMessage[],
  options?: { preserveLatest?: boolean },
): ModelMessage[] {
  let latestToolMessageIndex = -1;
  if (options?.preserveLatest) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "tool") {
        latestToolMessageIndex = index;
        break;
      }
    }
  }

  return messages.map((msg, index) => {
    if (
      msg.role !== "tool" ||
      index === latestToolMessageIndex ||
      !Array.isArray(msg.content)
    ) {
      return msg;
    }

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

function toolResultCompaction(
  originalTokens: number,
  compressedTokens: number,
): TruncationResult["toolResultCompaction"] {
  return compressedTokens < originalTokens
    ? { originalTokens, compressedTokens }
    : undefined;
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
// 截断
// ---------------------------------------------------------------------------

/**
 * 截断 ModelMessage 数组，使其符合 token 预算。
 *
 * 策略（按优先级顺序）：
 * 1. 压缩超过 2000 字符的工具结果
 * 2. 从开头移除较早的消息轮次
 * 3. 在开头插入一条截断提示
 *
 * 边界情况：
 * - budget <= 0 → 使用 DEFAULT_TOKEN_BUDGET
 * - 单条消息超出预算 → 截断其文本内容
 */
export function truncateToFit(
  messages: ModelMessage[],
  budget?: number,
  options?: TruncationOptions,
): TruncationResult {
  const effectiveBudget =
    budget != null && budget > 0 ? budget : DEFAULT_TOKEN_BUDGET;
  const recentMessageCount = normalizeRecentMessageCount(
    options?.recentMessageCount,
  );

  if (messages.length === 0) {
    return {
      messages: [],
      wasTruncated: false,
      compressionStage: "none",
      messagesDropped: 0,
    };
  }

  // 检查是否已在预算之内
  if (estimateTokens(messages) <= effectiveBudget) {
    return {
      messages: [...messages],
      wasTruncated: false,
      compressionStage: "none",
      messagesDropped: 0,
    };
  }

  // 策略 1：压缩过大的工具结果
  const result = compressToolResults(messages);

  if (estimateTokens(result) <= effectiveBudget) {
    const originalTokens = estimateTokens(messages);
    const compressedTokens = estimateTokens(result);
    return {
      messages: result,
      wasTruncated: false,
      compressionStage:
        compressedTokens < originalTokens ? "tool-result-compaction" : "none",
      messagesDropped: 0,
      toolResultCompaction: toolResultCompaction(
        originalTokens,
        compressedTokens,
      ),
    };
  }

  // 策略 2/3：从开头移除较早消息，但硬保留最近窗口，并插入截断提示
  return truncateWithRecentRetention(
    result,
    effectiveBudget,
    recentMessageCount,
  );
}

function normalizeRecentMessageCount(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_RECENT_MESSAGE_COUNT;
  }
  return Math.max(1, Math.floor(value));
}

function truncateWithRecentRetention(
  messages: ModelMessage[],
  effectiveBudget: number,
  recentMessageCount: number,
): TruncationResult {
  const notice: ModelMessage = {
    role: "system",
    content: TRUNCATION_NOTICE,
  };
  const noticeTokens = estimateTokens([notice]);
  const includeNotice = effectiveBudget > noticeTokens + 1;
  const contentBudget = Math.max(
    0,
    includeNotice ? effectiveBudget - noticeTokens : effectiveBudget,
  );

  const protectedStart = Math.max(0, messages.length - recentMessageCount);
  const protectedTail = messages.slice(protectedStart);
  let result = truncateProtectedMessagesToBudget(protectedTail, contentBudget);
  let usedTokens = estimateTokens(result);

  for (let i = protectedStart - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    const candidateTokens = estimateTokens([candidate]);
    if (usedTokens + candidateTokens > contentBudget) continue;
    result = [candidate, ...result];
    usedTokens += candidateTokens;
  }

  const messagesWithNotice = includeNotice ? [notice, ...result] : result;
  return {
    messages: messagesWithNotice,
    wasTruncated: true,
    compressionStage: "safe-truncation",
    messagesDropped: messages.length - result.length,
  };
}

function truncateProtectedMessagesToBudget(
  messages: ModelMessage[],
  budget: number,
): ModelMessage[] {
  if (messages.length === 0 || estimateTokens(messages) <= budget) {
    return [...messages];
  }

  let remainingBudget = Math.max(0, budget);
  const result: ModelMessage[] = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const messageBudget = remainingBudget;
    const messageTokens = estimateTokens([messages[i]]);
    const next =
      messageTokens <= messageBudget
        ? messages[i]
        : truncateSingleMessage(messages[i], messageBudget);
    result[i] = next;
    remainingBudget = Math.max(0, remainingBudget - estimateTokens([next]));
  }

  return result;
}

/**
 * 截断单条消息的文本内容，使其符合 token 预算。
 * 使用 CJK 比率（1.5 字符/token）作为保守估算，
 * 以确保无论何种文字都不会超出预算。
 */
function truncateSingleMessage(
  msg: ModelMessage,
  budget: number,
): ModelMessage {
  const maxChars = Math.floor(budget * 1.5);

  // 仅对 user/system/assistant 消息截断字符串内容
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

// ---------------------------------------------------------------------------
// 带可选 LLM 压缩的异步截断
// ---------------------------------------------------------------------------

export interface CompressionResult {
  hadError?: boolean;
  messages: ModelMessage[];
  wasCompressed: boolean;
}

/**
 * truncateToFit 的异步版本，支持可选的 LLM 压缩器。
 *
 * 若简单截断后仍超出预算且提供了压缩器，则委托给压缩器处理。
 * 失败时回退到简单截断。
 */
export async function truncateToFitAsync(
  messages: ModelMessage[],
  budget?: number,
  compressor?: (
    msgs: ModelMessage[],
    budget: number,
  ) => Promise<CompressionResult>,
  options?: {
    compressionTargetBudget?: number | null;
    compressionTriggerBudget?: number | null;
    forceCompression?: boolean;
    recentMessageCount?: number;
  },
): Promise<TruncationResult> {
  const effectiveBudget =
    budget != null && budget > 0 ? budget : DEFAULT_TOKEN_BUDGET;
  const compressionTriggerBudget =
    options?.compressionTriggerBudget != null &&
    Number.isFinite(options.compressionTriggerBudget) &&
    options.compressionTriggerBudget > 0
      ? Math.min(effectiveBudget, Math.floor(options.compressionTriggerBudget))
      : null;
  const compressionTargetBudget =
    options?.compressionTargetBudget != null &&
    Number.isFinite(options.compressionTargetBudget) &&
    options.compressionTargetBudget > 0
      ? Math.min(effectiveBudget, Math.floor(options.compressionTargetBudget))
      : (compressionTriggerBudget ?? effectiveBudget);

  if (messages.length === 0) {
    return {
      messages: [],
      wasTruncated: false,
      compressionStage: "none",
      messagesDropped: 0,
    };
  }

  const originalTokens = estimateTokens(messages);
  const forceCompression = options?.forceCompression === true;

  // 检查是否已在预算之内
  if (originalTokens <= effectiveBudget) {
    if (
      !compressor ||
      compressionTriggerBudget == null ||
      (!forceCompression && originalTokens <= compressionTriggerBudget)
    ) {
      return {
        messages: [...messages],
        wasTruncated: false,
        compressionStage: "none",
        messagesDropped: 0,
      };
    }

    const compressed = compressToolResults(messages);
    const compressedTokens = estimateTokens(compressed);
    if (!forceCompression && compressedTokens <= compressionTriggerBudget) {
      return {
        messages: compressed,
        wasTruncated: false,
        compressionStage:
          compressedTokens < originalTokens ? "tool-result-compaction" : "none",
        messagesDropped: 0,
        toolResultCompaction: toolResultCompaction(
          originalTokens,
          compressedTokens,
        ),
      };
    }

    try {
      const result = await compressor(compressed, compressionTargetBudget);
      if (
        !result.hadError &&
        estimateTokens(result.messages) <= effectiveBudget
      ) {
        return {
          messages: result.messages,
          wasTruncated: result.wasCompressed,
          compressionStage: result.wasCompressed ? "llm-summary" : "none",
          messagesDropped: 0,
        };
      }
    } catch (err) {
      console.warn(
        "[token-budget] LLM compression failed below hard budget, using original context:",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      messages: [...messages],
      wasTruncated: false,
      compressionStage: "none",
      messagesDropped: 0,
    };
  }

  // 策略 1：压缩工具结果
  const compressed = compressToolResults(messages);
  const compressedTokens = estimateTokens(compressed);
  if (compressedTokens <= effectiveBudget) {
    if (
      compressor &&
      compressionTriggerBudget != null &&
      compressedTokens > compressionTriggerBudget
    ) {
      try {
        const result = await compressor(compressed, compressionTargetBudget);
        if (
          !result.hadError &&
          estimateTokens(result.messages) <= effectiveBudget
        ) {
          return {
            messages: result.messages,
            wasTruncated: result.wasCompressed,
            compressionStage: result.wasCompressed ? "llm-summary" : "none",
            messagesDropped: 0,
          };
        }
      } catch (err) {
        console.warn(
          "[token-budget] LLM compression failed after tool result compaction, using compacted context:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      messages: compressed,
      wasTruncated: false,
      compressionStage:
        compressedTokens < originalTokens ? "tool-result-compaction" : "none",
      messagesDropped: 0,
      toolResultCompaction: toolResultCompaction(
        originalTokens,
        compressedTokens,
      ),
    };
  }

  // 策略 2：如可用则尝试 LLM 压缩
  if (compressor) {
    try {
      const result = await compressor(compressed, compressionTargetBudget);
      if (
        !result.hadError &&
        estimateTokens(result.messages) <= effectiveBudget
      ) {
        return {
          messages: result.messages,
          wasTruncated: result.wasCompressed,
          compressionStage: result.wasCompressed ? "llm-summary" : "none",
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

  // 策略 3：回退到简单的从头丢弃
  return truncateToFit(compressed, budget, {
    recentMessageCount: options?.recentMessageCount,
  });
}
