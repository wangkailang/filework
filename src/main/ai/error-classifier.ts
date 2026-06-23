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
  | "quota_exceeded"
  | "unsupported_model"
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
  quota_exceeded: {
    type: "quota_exceeded",
    retryable: false,
    shouldCompress: false,
    maxRetries: 0,
    backoffMs: 0,
    userMessage: "当前模型额度已用尽，请切换到其他模型或稍后重试",
    recoveryActions: ["settings"],
  },
  unsupported_model: {
    type: "unsupported_model",
    retryable: false,
    shouldCompress: false,
    maxRetries: 0,
    backoffMs: 0,
    userMessage: "当前模型不支持当前接口，请切换到可用模型后重试",
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

type ErrorContext = {
  combinedMsg: string;
  headers: Record<string, string>;
  url: string;
};

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).join(", ");
  return "";
};

const tryParseJson = (value: string): unknown | null => {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const collectErrorContext = (error: unknown): ErrorContext => {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  let url = "";
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || seen.has(value)) return;
    const record = toRecord(value);
    if (!record) {
      const text = stringifyValue(value);
      if (text) chunks.push(text);
      return;
    }
    seen.add(value);

    if (value instanceof Error) {
      chunks.push(value.message, value.name);
    }

    for (const key of ["message", "name", "statusCode", "responseBody"]) {
      const text = stringifyValue(record[key]);
      if (text) chunks.push(text);
    }

    const responseBody = stringifyValue(record.responseBody);
    if (responseBody) {
      const parsedBody = tryParseJson(responseBody);
      if (parsedBody) visit(parsedBody, depth + 1);
    }

    const nextUrl = stringifyValue(record.url);
    if (nextUrl && !url) url = nextUrl;

    const responseHeaders = toRecord(record.responseHeaders);
    if (responseHeaders) {
      for (const [key, raw] of Object.entries(responseHeaders)) {
        const text = stringifyValue(raw);
        if (!text) continue;
        headers[key.toLowerCase()] = text;
        chunks.push(`${key}: ${text}`);
      }
    }

    visit(record.lastError, depth + 1);
    visit(record.cause, depth + 1);
    visit(record.data, depth + 1);
    visit(record.error, depth + 1);
  };

  visit(error, 0);
  return { combinedMsg: chunks.filter(Boolean).join(" "), headers, url };
};

const getRetryAfterSeconds = (
  headers: Record<string, string>,
): number | null => {
  const raw =
    headers["x-ratelimit-user-retry-after"] ??
    headers["x-ratelimit-quota-exceeded-retry-after"] ??
    headers["retry-after"];
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

const formatApproxDuration = (totalSeconds: number): string => {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0)
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${Math.max(1, totalSeconds)} 秒`;
};

const providerNameFromUrl = (url: string): string =>
  /githubcopilot|copilot/i.test(url) ? "GitHub Copilot" : "当前模型";

const buildQuotaExceededMessage = (context: ErrorContext): string => {
  const retryAfterSeconds = getRetryAfterSeconds(context.headers);
  const waitText = retryAfterSeconds
    ? `服务端建议等待约 ${formatApproxDuration(retryAfterSeconds)} 后再试。`
    : "";
  return `${providerNameFromUrl(context.url)} 额度已用尽。${waitText}请切换到其他模型，或等额度恢复后重试。`;
};

const extractUnsupportedModelName = (message: string): string | null => {
  const quoted = message.match(/\bmodel\s+"([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  return message.match(/\bmodel\s+([^\s"']+)/i)?.[1] ?? null;
};

const buildUnsupportedModelMessage = (context: ErrorContext): string => {
  const model = extractUnsupportedModelName(context.combinedMsg);
  const modelText = model ? `模型 "${model}"` : "当前模型";
  return `${modelText} 不支持当前接口。请在设置中切换到模型列表里的可用模型，或刷新模型列表后重试。`;
};

/**
 * 将 API 错误分类为带有恢复提示的结构化类型。
 *
 * 为保证分类的健壮性,会检查 error.message、error.name,以及
 * (针对 Vercel AI SDK 的 APICallError)数值型的 statusCode 属性。
 */
export function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const context = collectErrorContext(error);

  // 构造一个包含 message、name 和状态码的合并字符串,
  // 以便各匹配规则能命中其中任意一项。
  const combinedMsg = context.combinedMsg || [err.message, err.name].join(" ");

  if (
    /\bquota[_\s-]?exceeded\b/i.test(combinedMsg) ||
    context.headers["x-ratelimit-exceeded"] === "quota_exceeded"
  ) {
    return {
      ...ERROR_DEFAULTS.quota_exceeded,
      userMessage: buildQuotaExceededMessage(context),
      originalError: err,
    };
  }

  if (
    /unsupported_api_for_model/i.test(combinedMsg) ||
    /not accessible via the \/chat\/completions endpoint/i.test(combinedMsg)
  ) {
    return {
      ...ERROR_DEFAULTS.unsupported_model,
      userMessage: buildUnsupportedModelMessage(context),
      originalError: err,
    };
  }

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
