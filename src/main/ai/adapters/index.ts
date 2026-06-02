/**
 * Provider Adapter Registry
 *
 * Maps provider names to their adapter implementations.
 * Adding a new provider only requires creating a new adapter file
 * and registering it here.
 */

import type { ProviderAdapter, ProviderConfig } from "./base";

export type { CacheMetrics, ProviderAdapter, ProviderConfig } from "./base";

import { AnthropicAdapter } from "./anthropic";
import { DeepSeekAdapter } from "./deepseek";
import { maybeWrapWithDevtools } from "./devtools";
import { OpenAIAdapter } from "./openai";
import { XiaomiAdapter } from "./xiaomi";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const openaiAdapter = new OpenAIAdapter();

const deepseekAdapter = new DeepSeekAdapter();

const adapters: Record<string, ProviderAdapter> = {
  anthropic: new AnthropicAdapter(),
  deepseek: deepseekAdapter,
  openai: openaiAdapter,
  // "custom", "ollama", and "minimax" share the OpenAI adapter — all expose
  // OpenAI-compatible /v1/chat/completions endpoints. baseUrl resolution
  // (e.g. MiniMax default region) is handled upstream in ai-models.ts.
  custom: openaiAdapter,
  ollama: openaiAdapter,
  minimax: openaiAdapter,
  // Xiaomi MiMo speaks the same wire protocol as DeepSeek-Reasoner but
  // mandates `reasoning_content` on EVERY assistant turn (not just the
  // latest). The deepseek adapter drops past reasoning. XiaomiAdapter
  // wraps deepseek with a fetch interceptor that re-stamps reasoning
  // captured from the original prompt — see xiaomi.ts banner.
  xiaomi: new XiaomiAdapter(),
};

// Hostnames whose API requires reasoning_content to be threaded back to
// the assistant message on every follow-up turn. The OpenAI adapter
// silently drops reasoning parts during message conversion, so any
// custom/openai-typed config pointing at one of these endpoints would
// otherwise 400 the moment the model emits reasoning. Force-route those
// to the DeepSeek adapter (the only OpenAI-compatible adapter we have
// that preserves reasoning_content).
const REASONING_HOST_PATTERNS = [/(^|\.)xiaomimimo\.com$/i];

function isReasoningPassThroughHost(baseUrl: string | null | undefined) {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return REASONING_HOST_PATTERNS.some((rx) => rx.test(host));
  } catch {
    return false;
  }
}

/**
 * Resolve the canonical adapter name from a provider config, applying
 * URL-based overrides for endpoints that require special handling
 * (e.g. Xiaomi MiMo's reasoning_content round-trip).
 */
export function resolveAdapterName(
  provider: string,
  baseUrl?: string | null,
): string {
  if (provider !== "xiaomi" && isReasoningPassThroughHost(baseUrl)) {
    return "xiaomi";
  }
  return provider;
}

/**
 * Get the adapter for a given provider name.
 * Falls back to OpenAI adapter for unknown providers
 * (OpenAI-compatible is the most common fallback).
 */
export function getAdapter(provider: string): ProviderAdapter {
  return adapters[provider] ?? adapters.openai;
}

/**
 * Create a model + adapter pair from a provider config.
 * Convenience function combining adapter lookup with model creation.
 */
export function createModelWithAdapter(config: ProviderConfig) {
  const resolved = resolveAdapterName(config.provider, config.baseUrl);
  const adapter = getAdapter(resolved);
  // devtools 中间件套在最外层,确保覆盖到已被各 adapter(如 xiaomi)包装过的模型。
  const model = maybeWrapWithDevtools(adapter.createModel(config));
  return { model, adapter };
}
