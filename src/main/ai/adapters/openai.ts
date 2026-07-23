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
import { buildProviderNativeCompactionOptions } from "./native-compaction";
import { resolveOpenAICompatibleBaseUrl } from "./openai-compatible-url";

type ResolveApiKey = NonNullable<ProviderConfig["resolveApiKey"]>;

const usesOpenAIChatCompletions = (config: ProviderConfig): boolean => {
  const isCustomEndpoint =
    config.provider === "custom" ||
    (config.baseUrl != null && !config.baseUrl.includes("api.openai.com"));
  const preferredApi = config.modelCapabilities?.preferredApi ?? null;
  return (
    preferredApi === "chat_completions" ||
    (isCustomEndpoint && preferredApi !== "responses")
  );
};

export function buildGithubCopilotFetch(
  providerFetch: typeof globalThis.fetch,
  resolveApiKey?: ResolveApiKey,
): typeof globalThis.fetch {
  const send = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    options?: { forceRefresh?: boolean },
  ) => {
    const headers = new Headers(init?.headers);
    headers.set("Editor-Version", "filework/0.1.0");
    headers.set("User-Agent", "Filework");
    headers.set("Copilot-Integration-Id", "vscode-chat");
    const apiKey = resolveApiKey
      ? options
        ? await resolveApiKey(options)
        : await resolveApiKey()
      : null;
    if (apiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    return providerFetch(input, {
      ...init,
      headers,
    });
  };

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await send(input, init);
    if (response.status !== 401 || !resolveApiKey) {
      return response;
    }
    return send(input, init, { forceRefresh: true });
  };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  createModel(config: ProviderConfig): LanguageModel {
    const resolvedBaseUrl = resolveOpenAICompatibleBaseUrl(
      config.baseUrl,
      config.apiPath,
    );
    const providerFetch = getProviderFetch();
    const fetch: typeof globalThis.fetch | undefined =
      config.provider === "github-copilot"
        ? buildGithubCopilotFetch(
            providerFetch ?? globalThis.fetch,
            config.resolveApiKey,
          )
        : providerFetch;
    const openai = createOpenAI({
      apiKey: config.apiKey || "",
      baseURL: resolvedBaseUrl,
      // 参见 provider-fetch.ts —— 启动时设置的、按 host 感知代理的 fetch。
      fetch,
    });
    return usesOpenAIChatCompletions(config)
      ? openai.chat(config.model)
      : openai(config.model);
  }

  supportsMultimodalToolResults(config: ProviderConfig): boolean {
    return (
      config.modelCapabilities?.supportsVision !== false &&
      !usesOpenAIChatCompletions(config)
    );
  }

  buildProviderOptions(config?: ProviderConfig) {
    // 禁用并行工具调用,使 `createPlan` 调用无法与其他工具在同一步骤中批处理
    // —— 这样它的「等待审批」才能真正暂停整个循环,而不会让同级工具
    //(如 webSearch 等)在未经审批的情况下执行。
    const shouldSendReasoningEffort =
      Boolean(config?.reasoningEffort) &&
      config?.modelCapabilities?.supportsReasoning !== false;
    const nativeOpenAIOptions = config
      ? (buildProviderNativeCompactionOptions(config).openai ?? {})
      : {};
    return {
      openai: {
        parallelToolCalls: false,
        ...(shouldSendReasoningEffort && {
          reasoningEffort: config?.reasoningEffort,
        }),
        ...nativeOpenAIOptions,
      },
    };
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
