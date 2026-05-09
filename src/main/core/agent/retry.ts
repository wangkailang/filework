/**
 * Domain-neutral retry helper.
 *
 * Mirrors the behavior of `src/main/ai/error-classifier.ts:withRetry` but
 * keeps `core/` free of the user-facing error strings and Chinese-locale
 * recovery messages that live in the IPC layer.
 *
 * The IPC layer plugs in an `ErrorClassifier` that delegates to the
 * existing `classifyError`. SDK consumers default to no retry.
 */

export interface ClassifiedRetryError {
  type: string;
  retryable: boolean;
  maxRetries: number;
  /** Base backoff in ms; doubled per attempt. */
  backoffMs: number;
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
