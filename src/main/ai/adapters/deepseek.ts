/**
 * DeepSeek Provider 适配器
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
      // 参见 provider-fetch.ts —— 在 bootstrap 时设置的按 host 感知代理的 fetch。
      fetch: getProviderFetch(),
    });
    return deepseek(config.model);
  }

  supportsMultimodalToolResults(): boolean {
    return false;
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
