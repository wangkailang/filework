import { ipcMain } from "electron";
import type { LlmConfig } from "../db";
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
  isDefault?: boolean;
}

interface UpdatePayload {
  id: string;
  name?: string;
  provider?: Provider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  isDefault?: boolean;
}

/**
 * Validate required fields based on provider type.
 * Returns an error message string if validation fails, or null if valid.
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
  ];
  if (!validProviders.includes(data.provider)) {
    return `Invalid provider: ${data.provider}`;
  }

  // openai/anthropic/deepseek require apiKey
  if (["openai", "anthropic", "deepseek"].includes(data.provider)) {
    if (!data.apiKey || data.apiKey.trim() === "") {
      return "apiKey is required for this provider";
    }
  }

  // ollama/custom require baseUrl
  if (["ollama", "custom"].includes(data.provider)) {
    if (!data.baseUrl || data.baseUrl.trim() === "") {
      return "baseUrl is required for this provider";
    }
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

      return createLlmConfig({
        name: data.name!,
        provider: data.provider!,
        apiKey: data.apiKey ?? null,
        baseUrl: data.baseUrl ?? null,
        model: data.model!,
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
