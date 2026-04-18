/**
 * AI Model Configuration and Management
 *
 * Delegates to provider adapters for model instantiation.
 * This module resolves LLM config from the database and returns
 * the appropriate model + adapter pair.
 */

import {
  createModelWithAdapter,
  getAdapter,
  type ProviderAdapter,
} from "../ai/adapters";
import { classifyError } from "../ai/error-classifier";
import { getDefaultLlmConfig, getLlmConfig } from "../db";

/**
 * Get both the model and its provider adapter by configuration ID.
 * The adapter provides provider-specific options and metadata extraction.
 */
export const getModelAndAdapterByConfigId = (configId?: string) => {
  const config = configId ? getLlmConfig(configId) : getDefaultLlmConfig();
  if (!config) {
    throw new Error("所选 LLM 配置不存在");
  }

  const { provider, apiKey, baseUrl, model: modelId } = config;
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

  return createModelWithAdapter({
    provider,
    apiKey: apiKey || "",
    baseUrl,
    model: modelId,
  });
};

/** Convenience wrapper — returns only the model (no adapter). */
export const getAIModelByConfigId = (configId?: string) =>
  getModelAndAdapterByConfigId(configId).model;

/**
 * Get the adapter for a provider name (without creating a model).
 */
export const getAdapterForProvider = (provider: string): ProviderAdapter =>
  getAdapter(provider);

/**
 * Check if an error is an authentication failure (401/403)
 * @deprecated Use `classifyError` from `../ai/error-classifier` instead.
 */
export const isAuthError = (error: unknown): boolean => {
  return classifyError(error).type === "auth";
};
