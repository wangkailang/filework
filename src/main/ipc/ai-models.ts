/**
 * AI Model Configuration and Management
 *
 * Handles different AI providers (OpenAI, Anthropic, DeepSeek, Ollama)
 * and model instantiation based on configuration.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { getDefaultLlmConfig, getLlmConfig } from "../db";

/**
 * Get AI model instance by configuration ID
 */
export const getAIModelByConfigId = (configId?: string) => {
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

  if (provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: apiKey || "",
      baseURL: baseUrl || undefined,
    });
    return anthropic(modelId);
  }

  if (provider === "deepseek") {
    const deepseek = createDeepSeek({
      apiKey: apiKey || "",
      baseURL: baseUrl || undefined,
    });
    return deepseek(modelId);
  }

  // Default to OpenAI (also handles custom endpoints and Ollama)
  // Custom endpoint detection: if provider is "custom" or baseUrl doesn't contain openai
  const isCustomEndpoint =
    provider === "custom" ||
    (baseUrl != null && !baseUrl.includes("api.openai.com"));
  const openai = createOpenAI({
    apiKey: apiKey || "",
    baseURL: baseUrl || undefined,
  });
  return isCustomEndpoint ? openai.chat(modelId) : openai(modelId);
};

/**
 * Check if an error is an authentication failure (401/403)
 */
export const isAuthError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const msg = error.message;
    return (
      msg.includes("401") ||
      msg.includes("403") ||
      msg.includes("Unauthorized") ||
      msg.includes("Forbidden")
    );
  }
  return false;
};
