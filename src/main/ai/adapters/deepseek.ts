/**
 * DeepSeek Provider Adapter
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import { getProviderFetch } from "../provider-fetch";
import {
  type CacheMetrics,
  NO_CACHE_METRICS,
  NO_PROVIDER_OPTIONS,
  type ProviderAdapter,
  type ProviderConfig,
} from "./base";

export class DeepSeekAdapter implements ProviderAdapter {
  readonly name = "deepseek";

  createModel(config: ProviderConfig): LanguageModel {
    const deepseek = createDeepSeek({
      apiKey: config.apiKey || "",
      baseURL: config.baseUrl || undefined,
      // See provider-fetch.ts — per-host proxy-aware fetch set at bootstrap.
      fetch: getProviderFetch(),
    });
    return deepseek(config.model);
  }

  buildProviderOptions() {
    return NO_PROVIDER_OPTIONS;
  }

  extractCacheMetrics(
    _providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics {
    return NO_CACHE_METRICS;
  }
}
