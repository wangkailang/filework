/**
 * AI 模型配置与管理
 *
 * 将模型实例化委托给各 provider 适配器。
 * 本模块从数据库解析 LLM 配置，并返回
 * 对应的 model + adapter 组合。
 */

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { getKnownModelLimitsForModelId } from "../../shared/model-context-window";
import {
  createModelWithAdapter,
  getAdapter,
  type ProviderAdapter,
  type ProviderConfig,
} from "../ai/adapters";
import { getProviderNativeCompaction } from "../ai/adapters/native-compaction";
import { classifyError } from "../ai/error-classifier";
import { getCompressionTriggerBudget } from "../ai/token-budget";
import { getLlmConfig, getLlmConfigs, type LlmConfig } from "../db";
import { getFreshGithubCopilotSessionToken } from "./github-copilot-session";

export interface LlmConfigSelection {
  config: LlmConfig;
  fallbackFromConfigId: string | null;
}

export interface LlmGenerationOptions {
  maxOutputTokens?: number;
  reasoningEffort?: string;
  temperature?: number;
  topP?: number;
}

export function resolveLlmModelLimits(
  config: Pick<
    LlmConfig,
    "maxOutputTokens" | "model" | "modelContextWindow" | "modelMaxOutputTokens"
  >,
): { contextWindow: number | null; maxOutputTokens: number | null } {
  const known = getKnownModelLimitsForModelId(config.model);
  return {
    contextWindow: config.modelContextWindow ?? known?.contextWindow ?? null,
    maxOutputTokens:
      config.maxOutputTokens ??
      config.modelMaxOutputTokens ??
      known?.maxOutputTokens ??
      null,
  };
}

export function isAvailableLlmConfig(config: LlmConfig): boolean {
  return (
    config.enabled !== false &&
    config.lastCheckStatus === "success" &&
    config.modelAvailable !== false
  );
}

export function isAvailableChatLlmConfig(config: LlmConfig): boolean {
  return config.modality === "chat" && isAvailableLlmConfig(config);
}

/**
 * 选择当前任务可用的聊天 LLM 配置。
 *
 * 优先使用用户显式选择的配置；若该配置已停用、测试失败、模型目录显示不可用，
 * 则按最近更新顺序回退到其它已测试成功的 chat 配置。
 */
export function selectAvailableChatLlmConfig(
  configId?: string,
): LlmConfigSelection {
  const configs = getLlmConfigs();
  const requestedConfig = configId
    ? (getLlmConfig(configId) ?? null)
    : (configs.find((config) => config.isDefault && config.enabled) ?? null);

  if (requestedConfig && isAvailableChatLlmConfig(requestedConfig)) {
    return { config: requestedConfig, fallbackFromConfigId: null };
  }

  const fallbackConfig = configs.find(
    (config) =>
      config.id !== requestedConfig?.id && isAvailableChatLlmConfig(config),
  );
  if (fallbackConfig) {
    return {
      config: fallbackConfig,
      fallbackFromConfigId: requestedConfig?.id ?? configId ?? null,
    };
  }

  throw new Error("没有可用的聊天 LLM 配置，请先在设置中启用并测试连接成功。");
}

/**
 * 根据配置 ID 同时获取 model 及其 provider 适配器。
 * 适配器提供 provider 专属的选项与元数据提取能力。
 */
export const getModelAndAdapterByConfigId = (configId?: string) => {
  const { config } = selectAvailableChatLlmConfig(configId);

  const {
    provider,
    apiKey,
    baseUrl,
    apiPath,
    model: modelId,
    temperature,
    topP,
    maxOutputTokens,
    reasoningEffort,
  } = config;
  const resolvedLimits = resolveLlmModelLimits(config);
  const resolvedMaxOutputTokens = resolvedLimits.maxOutputTokens;
  const compressionTriggerBudget = getCompressionTriggerBudget({
    modelId,
    contextWindow: resolvedLimits.contextWindow,
    maxOutputTokens: resolvedMaxOutputTokens,
  });
  console.log(
    "[AI] provider:",
    provider,
    "model:",
    modelId,
    "configId:",
    config.id,
  );

  if (!apiKey && provider !== "custom") {
    throw new Error(`API Key 未配置，请在设置中填写 ${provider} 的 API Key`);
  }

  // 未设置 baseUrl 时，MiniMax 使用按区域默认的 OpenAI 兼容端点。
  // 默认走中国大陆；用户可在 LLM 配置表单中覆盖
  // （例如改为 api.minimax.io）。
  const resolvedBaseUrl =
    provider === "minimax" && !baseUrl
      ? "https://api.minimaxi.com/v1"
      : baseUrl;

  const providerConfig: ProviderConfig = {
    provider,
    apiKey: apiKey || "",
    resolveApiKey:
      provider === "github-copilot"
        ? async (options?: { forceRefresh?: boolean }) => {
            const token = await getFreshGithubCopilotSessionToken({
              configId: config.id,
              forceRefresh: options?.forceRefresh,
            });
            return token.apiToken;
          }
        : undefined,
    baseUrl: resolvedBaseUrl,
    apiPath,
    model: modelId,
    reasoningEffort,
    compressionTriggerBudget,
    maxOutputTokens: resolvedMaxOutputTokens,
    modelContextWindow: resolvedLimits.contextWindow,
    modelCapabilities: config.modelCapabilities,
  };
  const modelWithAdapter = createModelWithAdapter(providerConfig);
  const generationOptions: LlmGenerationOptions = {
    ...(temperature !== null && temperature !== undefined && { temperature }),
    ...(topP !== null && topP !== undefined && { topP }),
    ...(maxOutputTokens !== null &&
      maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };

  return {
    ...modelWithAdapter,
    generationOptions,
    modelLimits: resolvedLimits,
    providerOptions: modelWithAdapter.adapter.buildProviderOptions(
      providerConfig,
    ) as ProviderOptions,
    providerNativeCompaction: getProviderNativeCompaction(providerConfig),
    modelId,
    configId: config.id,
  };
};

/** 便捷封装 —— 仅返回 model（不含 adapter）。 */
export const getAIModelByConfigId = (configId?: string) =>
  getModelAndAdapterByConfigId(configId).model;

/**
 * 根据 provider 名称获取适配器（不创建 model）。
 */
export const getAdapterForProvider = (provider: string): ProviderAdapter =>
  getAdapter(provider);

/**
 * 判断错误是否为认证失败（401/403）
 * @deprecated 请改用 `../ai/error-classifier` 中的 `classifyError`。
 */
export const isAuthError = (error: unknown): boolean => {
  return classifyError(error).type === "auth";
};
