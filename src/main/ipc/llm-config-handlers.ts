import { ipcMain } from "electron";
import type { LlmConfig, LlmModality } from "../db";
import {
  createLlmConfig,
  deleteLlmConfig,
  getLlmConfig,
  getLlmConfigs,
  setDefaultLlmConfig,
  updateLlmConfig,
} from "../db";

type Provider = LlmConfig["provider"];

interface CreatePayload {
  name?: string;
  provider?: Provider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modality?: LlmModality;
  isDefault?: boolean;
}

interface UpdatePayload {
  id: string;
  name?: string;
  provider?: Provider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modality?: LlmModality;
  isDefault?: boolean;
}

/**
 * 根据 provider 类型校验必填字段。
 * 校验失败时返回错误信息字符串,校验通过时返回 null。
 */
export function validateLlmConfigPayload(data: CreatePayload): string | null {
  if (!data.name || data.name.trim() === "") {
    return "name is required";
  }
  if (!data.model || data.model.trim() === "") {
    return "model is required";
  }
  if (!data.provider) {
    return "provider is required";
  }

  const validProviders: Provider[] = [
    "openai",
    "anthropic",
    "deepseek",
    "ollama",
    "custom",
    "minimax",
    "xiaomi",
  ];
  if (!validProviders.includes(data.provider)) {
    return `Invalid provider: ${data.provider}`;
  }

  // 托管类 provider 都需要 apiKey。MiniMax 无论何种 modality 都需要
  // (chat / image / video 共用同一个 key)。
  // 小米 MiMo 同样需要小米开放平台提供的 apiKey。
  if (
    ["openai", "anthropic", "deepseek", "minimax", "xiaomi"].includes(
      data.provider,
    )
  ) {
    if (!data.apiKey || data.apiKey.trim() === "") {
      return "apiKey is required for this provider";
    }
  }

  // ollama/custom/xiaomi 需要显式指定 baseUrl。我们依赖的任何 SDK 都
  // 没有内置小米开放平台的默认 endpoint;
  // 用户需从小米开发者控制台粘贴。
  if (["ollama", "custom", "xiaomi"].includes(data.provider)) {
    if (!data.baseUrl || data.baseUrl.trim() === "") {
      return "baseUrl is required for this provider";
    }
  }

  if (data.modality && !["chat", "image", "video"].includes(data.modality)) {
    return `Invalid modality: ${data.modality}`;
  }

  return null;
}

export const registerLlmConfigHandlers = () => {
  ipcMain.handle("llm-config:list", async () => {
    try {
      return getLlmConfigs();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("llm-config:get", async (_event, payload: { id: string }) => {
    try {
      return getLlmConfig(payload.id);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("llm-config:create", async (_event, data: CreatePayload) => {
    try {
      const validationError = validateLlmConfigPayload(data);
      if (validationError) {
        return { error: validationError };
      }

      // 校验已保证必填字段存在,但这里仍做一次防护
      // 以满足 lint 规则(禁止非空断言)并保证运行时安全。
      const name = data.name ?? "";
      const provider = data.provider ?? "";
      const model = data.model ?? "";
      if (!name || !provider || !model) {
        return { error: "Invalid LLM config payload" };
      }

      return createLlmConfig({
        name,
        provider,
        apiKey: data.apiKey ?? null,
        baseUrl: data.baseUrl ?? null,
        model,
        modality: data.modality ?? "chat",
        isDefault: data.isDefault ?? false,
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    "llm-config:update",
    async (_event, payload: UpdatePayload) => {
      try {
        const { id, isDefault, ...updates } = payload;
        if (Object.keys(updates).length > 0) {
          updateLlmConfig(id, updates);
        }
        if (isDefault) {
          setDefaultLlmConfig(id);
        }
        return getLlmConfig(id);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "llm-config:delete",
    async (_event, payload: { id: string }) => {
      try {
        deleteLlmConfig(payload.id);
        return { success: true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
};
