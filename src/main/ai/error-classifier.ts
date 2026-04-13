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
	| "rate_limit"
	| "context_overflow"
	| "server_error"
	| "timeout"
	| "unknown";

export interface ClassifiedError {
	type: ErrorType;
	retryable: boolean;
	shouldCompress: boolean;
	maxRetries: number;
	/** Base backoff in ms (doubled each attempt) */
	backoffMs: number;
	/** User-facing message (Chinese) */
	userMessage: string;
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
		test: (m) => /\b(401|403)\b/.test(m) || /unauthorized|forbidden/i.test(m),
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
	},
	rate_limit: {
		type: "rate_limit",
		retryable: true,
		shouldCompress: false,
		maxRetries: 3,
		backoffMs: 2000,
		userMessage: "请求频率过高，正在自动重试…",
	},
	context_overflow: {
		type: "context_overflow",
		retryable: true,
		shouldCompress: true,
		maxRetries: 1,
		backoffMs: 0,
		userMessage: "对话上下文过长，正在自动压缩后重试…",
	},
	server_error: {
		type: "server_error",
		retryable: true,
		shouldCompress: false,
		maxRetries: 2,
		backoffMs: 1000,
		userMessage: "服务端暂时不可用，正在自动重试…",
	},
	timeout: {
		type: "timeout",
		retryable: true,
		shouldCompress: false,
		maxRetries: 2,
		backoffMs: 1500,
		userMessage: "连接超时，正在自动重试…",
	},
	unknown: {
		type: "unknown",
		retryable: false,
		shouldCompress: false,
		maxRetries: 0,
		backoffMs: 0,
		userMessage: "",
	},
};

/**
 * Classify an API error into a structured type with recovery hints.
 */
export function classifyError(error: unknown): ClassifiedError {
	const err = error instanceof Error ? error : new Error(String(error));
	const msg = err.message;

	for (const { test, type } of STATUS_PATTERNS) {
		if (test(msg)) {
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
