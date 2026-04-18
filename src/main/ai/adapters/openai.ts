/**
 * OpenAI Provider Adapter
 *
 * Handles OpenAI-specific concerns:
 * - Model creation via @ai-sdk/openai (also handles custom endpoints)
 * - Cache metrics extraction (prompt_tokens_details.cached_tokens)
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  type CacheMetrics,
  NO_CACHE_METRICS,
  NO_PROVIDER_OPTIONS,
  type ProviderAdapter,
  type ProviderConfig,
} from "./base";

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  createModel(config: ProviderConfig): LanguageModel {
    const isCustomEndpoint =
      config.provider === "custom" ||
      (config.baseUrl != null && !config.baseUrl.includes("api.openai.com"));
    const openai = createOpenAI({
      apiKey: config.apiKey || "",
      baseURL: config.baseUrl || undefined,
    });
    return isCustomEndpoint ? openai.chat(config.model) : openai(config.model);
  }

  buildProviderOptions() {
    return NO_PROVIDER_OPTIONS;
  }

  extractCacheMetrics(
    providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics {
    const openai = providerMetadata?.openai as
      | Record<string, unknown>
      | undefined;
    if (!openai) return NO_CACHE_METRICS;

    const oaiUsage = openai.usage as Record<string, unknown> | null | undefined;
    const promptDetails = oaiUsage?.prompt_tokens_details as
      | Record<string, unknown>
      | null
      | undefined;
    const cachedTokens =
      (promptDetails?.cached_tokens as number | null) ?? null;

    if (cachedTokens && cachedTokens > 0) {
      return { cacheWriteTokens: null, cacheReadTokens: cachedTokens };
    }
    return NO_CACHE_METRICS;
  }
}
