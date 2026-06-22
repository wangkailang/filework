/**
 * OpenAI Provider 适配器
 *
 * 处理 OpenAI 特有的事项:
 * - 通过 @ai-sdk/openai 创建模型(同时处理自定义端点)
 * - 缓存指标提取(prompt_tokens_details.cached_tokens)
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getProviderFetch } from "../provider-fetch";
import {
  type CacheMetrics,
  NO_CACHE_METRICS,
  type ProviderAdapter,
  type ProviderConfig,
} from "./base";
import { resolveOpenAICompatibleBaseUrl } from "./openai-compatible-url";

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  createModel(config: ProviderConfig): LanguageModel {
    const isCustomEndpoint =
      config.provider === "custom" ||
      (config.baseUrl != null && !config.baseUrl.includes("api.openai.com"));
    const resolvedBaseUrl = resolveOpenAICompatibleBaseUrl(
      config.baseUrl,
      config.apiPath,
    );
    const providerFetch = getProviderFetch();
    const fetch: typeof globalThis.fetch | undefined =
      config.provider === "github-copilot"
        ? (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set("Editor-Version", "filework/0.1.0");
            headers.set("User-Agent", "Filework");
            headers.set("Copilot-Integration-Id", "vscode-chat");
            return (providerFetch ?? globalThis.fetch)(input, {
              ...init,
              headers,
            });
          }
        : providerFetch;
    const openai = createOpenAI({
      apiKey: config.apiKey || "",
      baseURL: resolvedBaseUrl,
      // 参见 provider-fetch.ts —— 启动时设置的、按 host 感知代理的 fetch。
      fetch,
    });
    return isCustomEndpoint ? openai.chat(config.model) : openai(config.model);
  }

  buildProviderOptions() {
    // 禁用并行工具调用,使 `createPlan` 调用无法与其他工具在同一步骤中批处理
    // —— 这样它的「等待审批」才能真正暂停整个循环,而不会让同级工具
    //(如 webSearch 等)在未经审批的情况下执行。
    return { openai: { parallelToolCalls: false } };
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
