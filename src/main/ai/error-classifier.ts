/**
 * API Error Classification & Retry Logic
 *
 * Provides structured error taxonomy and recovery strategies for LLM API calls.
 * Inspired by Hermes Agent's error_classifier.py.
 */

// ---------------------------------------------------------------------------
// Error taxonomy
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

/** Recovery actions the renderer can offer to the user */
export type RecoveryAction = "retry" | "settings" | "new_chat";

export interface ClassifiedError {
  type: ErrorType;
  retryable: boolean;
  shouldCompress: boolean;
  maxRetries: number;
  /** Base backoff in ms (doubled each attempt) */
  backoffMs: number;
  /** User-facing message (Chinese) */
  userMessage: string;
  /** Suggested recovery actions for the UI to render as buttons */
  recoveryActions: RecoveryAction[];
  originalError: Error;
}

// ---------------------------------------------------------------------------
// Classification
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
 * Classify an API error into a structured type with recovery hints.
 *
 * Checks error.message, error.name, and — for Vercel AI SDK APICallError —
 * the numeric statusCode property for robust classification.
 */
export function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));

  // Build a combined string that includes message, name, and status code so
  // that patterns can match on any of them.
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
// Retry wrapper
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Called before each retry attempt */
  onRetry?: (attempt: number, classified: ClassifiedError) => void;
  /** AbortSignal to cancel retries */
  signal?: AbortSignal;
}

/**
 * Execute `fn` with automatic retries based on error classification.
 *
 * - Classifies each error to determine retry eligibility
 * - Uses exponential backoff (backoffMs * 2^attempt)
 * - Respects AbortSignal
 * - Calls `onRetry` before each retry so callers can update UI
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

      // Exponential backoff
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
