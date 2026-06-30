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
import { buildProviderNativeCompactionOptions } from "./native-compaction";

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  createModel(config: ProviderConfig): LanguageModel {
    const anthropic = createAnthropic({
      apiKey: config.apiKey || "",
      baseURL: config.baseUrl || undefined,
      // 按 host 感知代理的 fetch(在 bootstrap 时设置)—— 避免使用全局
      // env 代理,后者可能缓冲流式响应。参见 provider-fetch.ts。
      fetch: getProviderFetch(),
    });
    return anthropic(config.model);
  }

  buildProviderOptions(config?: ProviderConfig) {
    const nativeAnthropicOptions = config
      ? (buildProviderNativeCompactionOptions(config).anthropic ?? {})
      : {};
    return {
      anthropic: {
        cacheControl: { type: "ephemeral" as const },
        // 参见 OpenAIAdapter:串行化工具调用,使 `createPlan` 的
        // 等待审批能中止循环,而不是继续运行其他并行调用。
        disableParallelToolUse: true,
        ...nativeAnthropicOptions,
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
