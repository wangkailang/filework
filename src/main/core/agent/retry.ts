/**
 * 与领域无关的重试辅助工具。
 *
 * 行为与 `src/main/ai/error-classifier.ts:withRetry` 一致,但让 `core/`
 * 不依赖那些位于 IPC 层、面向用户的错误字符串与中文本地化恢复信息。
 *
 * IPC 层会接入一个委托给现有 `classifyError` 的 `ErrorClassifier`。
 * SDK 使用方默认不重试。
 */

export interface ClassifiedRetryError {
  type: string;
  retryable: boolean;
  maxRetries: number;
  /** 基础退避时长(毫秒);每次尝试翻倍。 */
  backoffMs: number;
  /** 面向用户的提示文案。IPC 层分类器可选择提供。 */
  userMessage?: string;
  /** UI 可渲染的恢复操作。IPC 层分类器可选择提供。 */
  recoveryActions?: string[];
}

export type ErrorClassifier = (err: unknown) => ClassifiedRetryError;

const noRetryClassifier: ErrorClassifier = () => ({
  type: "unknown",
  retryable: false,
  maxRetries: 0,
  backoffMs: 0,
});

export interface WithRetryOptions {
  classify?: ErrorClassifier;
  onRetry?: (attempt: number, errorType: string) => void;
  signal?: AbortSignal;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const classify = opts.classify ?? noRetryClassifier;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const c = classify(err);
      if (!c.retryable || attempt >= c.maxRetries) throw err;
      attempt++;
      opts.onRetry?.(attempt, c.type);
      const delay = c.backoffMs * 2 ** (attempt - 1);
      if (delay > 0) await sleep(delay, opts.signal);
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
