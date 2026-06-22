/**
 * AI 模型配置与管理
 *
 * 将模型实例化委托给各 provider 适配器。
 * 本模块从数据库解析 LLM 配置，并返回
 * 对应的 model + adapter 组合。
 */

import {
  createModelWithAdapter,
  getAdapter,
  type ProviderAdapter,
} from "../ai/adapters";
import { classifyError } from "../ai/error-classifier";
import { getDefaultLlmConfig, getLlmConfig } from "../db";

/**
 * 根据配置 ID 同时获取 model 及其 provider 适配器。
 * 适配器提供 provider 专属的选项与元数据提取能力。
 */
export const getModelAndAdapterByConfigId = (configId?: string) => {
  const config = configId ? getLlmConfig(configId) : getDefaultLlmConfig();
  if (!config) {
    throw new Error("所选 LLM 配置不存在");
  }

  if (config.enabled === false) {
    throw new Error("所选 LLM 配置已停用，请在设置中启用后再使用");
  }

  const { provider, apiKey, baseUrl, apiPath, model: modelId } = config;
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

  return {
    ...createModelWithAdapter({
      provider,
      apiKey: apiKey || "",
      baseUrl: resolvedBaseUrl,
      apiPath,
      model: modelId,
    }),
    modelId,
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
