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
import { OpenAIAdapter } from "./openai";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const openaiAdapter = new OpenAIAdapter();

const adapters: Record<string, ProviderAdapter> = {
  anthropic: new AnthropicAdapter(),
  deepseek: new DeepSeekAdapter(),
  openai: openaiAdapter,
  // "custom", "ollama", and "minimax" share the OpenAI adapter — all expose
  // OpenAI-compatible /v1/chat/completions endpoints. baseUrl resolution
  // (e.g. MiniMax default region) is handled upstream in ai-models.ts.
  custom: openaiAdapter,
  ollama: openaiAdapter,
  minimax: openaiAdapter,
};

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
  const adapter = getAdapter(config.provider);
  const model = adapter.createModel(config);
  return { model, adapter };
}
