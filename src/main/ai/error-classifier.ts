/**
 * API 错误分类与重试逻辑
 *
 * 为 LLM API 调用提供结构化的错误分类体系与恢复策略。
 * 灵感来自 Hermes Agent 的 error_classifier.py。
 */

// ---------------------------------------------------------------------------
// 错误分类体系
// ---------------------------------------------------------------------------

export type ErrorType =
  | "auth"
  | "billing"
  | "rate_limit"
  | "context_overflow"
  | "server_error"
  | "timeout"
  | "proxy_intercepted"
  | "unknown";

/** 渲染进程可向用户提供的恢复操作 */
export type RecoveryAction = "retry" | "settings" | "new_chat";

export interface ClassifiedError {
  type: ErrorType;
  retryable: boolean;
  shouldCompress: boolean;
  maxRetries: number;
  /** 基础退避时间(毫秒,每次尝试翻倍) */
  backoffMs: number;
  /** 面向用户的提示文案(中文) */
  userMessage: string;
  /** 供 UI 渲染为按钮的建议恢复操作 */
  recoveryActions: RecoveryAction[];
  originalError: Error;
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

const STATUS_PATTERNS: Array<{
  test: (msg: string) => boolean;
  type: ErrorType;
}> = [
  {
    test: (m) =>
      /credit.?balance|billing|insufficient.?funds|purchase.?credits/i.test(m),
    type: "billing",
  },
  {
    test: (m) =>
      /\b(401|403)\b/.test(m) ||
      /unauthorized|forbidden|invalid.{0,10}(api.?key|key|token)/i.test(m),
    type: "auth",
  },
  {
    test: (m) =>
      /\b429\b/.test(m) || /rate.?limit|too many requests|quota/i.test(m),
    type: "rate_limit",
  },
  {
    test: (m) =>
      /context.?length|too many tokens|maximum.?context|max.?tokens|token.?limit/i.test(
        m,
      ),
    type: "context_overflow",
  },
  {
    test: (m) =>
      /\b(500|502|503|504|529)\b/.test(m) ||
      /internal server error|overloaded|service unavailable/i.test(m),
    type: "server_error",
  },
  {
    test: (m) =>
      /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(m),
    type: "timeout",
  },
  {
    test: (m) =>
      /APICallError|API.?Call.?Error|fetch failed|network error/i.test(m),
    type: "timeout",
  },
  {
    test: (m) =>
      /<!DOCTYPE|<html|cloudflare|captcha|cf-ray|attention required/i.test(m),
    type: "proxy_intercepted",
  },
];

const ERROR_DEFAULTS: Record<
  ErrorType,
  Omit<ClassifiedError, "originalError">
> = {
  auth: {
    type: "auth",
    retryable: false,
    shouldCompress: false,
    maxRetries: 0,
    backoffMs: 0,
    userMessage: "API Key 无效或已过期，请在设置中检查该渠道配置",
    recoveryActions: ["settings"],
  },
  billing: {
    type: "billing",
    retryable: false,
    shouldCompress: false,
    maxRetries: 0,
    backoffMs: 0,
    userMessage: "API 账户余额不足，请前往对应平台充值后重试",
    recoveryActions: ["settings"],
  },
  rate_limit: {
    type: "rate_limit",
    retryable: true,
    shouldCompress: false,
    maxRetries: 3,
    backoffMs: 2000,
    userMessage: "请求频率过高，正在自动重试…",
    recoveryActions: ["retry"],
  },
  context_overflow: {
    type: "context_overflow",
    retryable: true,
    shouldCompress: true,
    maxRetries: 1,
    backoffMs: 0,
    userMessage: "对话上下文过长，正在自动压缩后重试…",
    recoveryActions: ["new_chat"],
  },
  server_error: {
    type: "server_error",
    retryable: true,
    shouldCompress: false,
    maxRetries: 2,
    backoffMs: 1000,
    userMessage: "服务端暂时不可用，正在自动重试…",
    recoveryActions: ["retry"],
  },
  timeout: {
    type: "timeout",
    retryable: true,
    shouldCompress: false,
    maxRetries: 2,
    backoffMs: 1500,
    userMessage: "连接超时，正在自动重试…",
    recoveryActions: ["retry", "settings"],
  },
  proxy_intercepted: {
    type: "proxy_intercepted",
    retryable: false,
    shouldCompress: false,
    maxRetries: 0,
    backoffMs: 0,
    userMessage: "请求被网络代理或防火墙拦截，请检查网络环境或代理设置",
    recoveryActions: ["settings"],
  },
  unknown: {
    type: "unknown",
    retryable: false,
    shouldCompress: false,
    maxRetries: 0,
    backoffMs: 0,
    userMessage: "",
    recoveryActions: ["retry"],
  },
};

/**
 * 将 API 错误分类为带有恢复提示的结构化类型。
 *
 * 为保证分类的健壮性,会检查 error.message、error.name,以及
 * (针对 Vercel AI SDK 的 APICallError)数值型的 statusCode 属性。
 */
export function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));

  // 构造一个包含 message、name 和状态码的合并字符串,
  // 以便各匹配规则能命中其中任意一项。
  const statusCode =
    typeof (error as Record<string, unknown>)?.statusCode === "number"
      ? String((error as Record<string, unknown>).statusCode)
      : "";
  const combinedMsg = [err.message, err.name, statusCode]
    .filter(Boolean)
    .join(" ");

  for (const { test, type } of STATUS_PATTERNS) {
    if (test(combinedMsg)) {
      return { ...ERROR_DEFAULTS[type], originalError: err };
    }
  }

  return {
    ...ERROR_DEFAULTS.unknown,
    userMessage: err.message,
    originalError: err,
  };
}

// ---------------------------------------------------------------------------
// 重试包装器
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** 在每次重试前调用 */
  onRetry?: (attempt: number, classified: ClassifiedError) => void;
  /** 用于取消重试的 AbortSignal */
  signal?: AbortSignal;
}

/**
 * 基于错误分类对 `fn` 执行自动重试。
 *
 * - 对每个错误进行分类以判断是否可重试
 * - 使用指数退避(backoffMs * 2^attempt)
 * - 遵循 AbortSignal
 * - 在每次重试前调用 `onRetry`,以便调用方更新 UI
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      const classified = classifyError(error);

      if (!classified.retryable || attempt >= classified.maxRetries) {
        throw error;
      }

      if (opts?.signal?.aborted) {
        throw error;
      }

      attempt++;
      opts?.onRetry?.(attempt, classified);

      // 指数退避
      const delay = classified.backoffMs * 2 ** (attempt - 1);
      if (delay > 0) {
        await sleep(delay, opts?.signal);
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
