/**
 * Anthropic Provider Adapter
 *
 * Handles Claude-specific concerns:
 * - Model creation via @ai-sdk/anthropic
 * - Ephemeral prompt caching
 * - Cache metrics extraction (cacheCreationInputTokens, cache_read_input_tokens)
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getProviderFetch } from "../provider-fetch";
import {
  type CacheMetrics,
  NO_CACHE_METRICS,
  type ProviderAdapter,
  type ProviderConfig,
} from "./base";

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  createModel(config: ProviderConfig): LanguageModel {
    const anthropic = createAnthropic({
      apiKey: config.apiKey || "",
      baseURL: config.baseUrl || undefined,
      // Per-host proxy-aware fetch (set at bootstrap) — avoids the global
      // env proxy that can buffer streaming responses. See provider-fetch.ts.
      fetch: getProviderFetch(),
    });
    return anthropic(config.model);
  }

  buildProviderOptions() {
    return {
      anthropic: {
        cacheControl: { type: "ephemeral" as const },
        // See OpenAIAdapter: serialize tool calls so `createPlan`'s
        // await-for-approval halts the loop instead of running siblings.
        disableParallelToolUse: true,
      },
    };
  }

  extractCacheMetrics(
    providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics {
    const anthropic = providerMetadata?.anthropic as
      | Record<string, unknown>
      | undefined;
    if (!anthropic) return NO_CACHE_METRICS;

    const cacheWrite =
      (anthropic.cacheCreationInputTokens as number | null) ?? null;
    const rawUsage = anthropic.usage as
      | Record<string, unknown>
      | null
      | undefined;
    const cacheRead =
      (rawUsage?.cache_read_input_tokens as number | null) ?? null;

    return { cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead };
  }
}
