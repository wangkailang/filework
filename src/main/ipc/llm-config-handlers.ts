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
import {
  completeGithubCopilotDeviceFlow,
  fetchGithubCopilotModels,
  startGithubCopilotDeviceFlow,
} from "./github-copilot-auth";
import { testLlmConfigConnection } from "./llm-config-connection";

type Provider = LlmConfig["provider"];
const GITHUB_COPILOT_DEFAULT_MODEL = "gpt-5.5";

interface CreatePayload {
  name?: string;
  provider?: Provider;
  apiKey?: string;
  baseUrl?: string;
  apiPath?: string;
  model?: string;
  modality?: LlmModality;
  enabled?: boolean;
  isDefault?: boolean;
}

interface UpdatePayload {
  id: string;
  name?: string;
  provider?: Provider;
  apiKey?: string;
  baseUrl?: string;
  apiPath?: string | null;
  model?: string;
  modality?: LlmModality;
  enabled?: boolean;
  isDefault?: boolean;
}

interface CompleteGithubCopilotPayload {
  deviceCode: string;
  name?: string;
  model?: string;
  configId?: string;
}

type LlmConfigResult = LlmConfig | { error: string };

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
    "github-copilot",
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
  if (
    ["ollama", "custom", "xiaomi", "github-copilot"].includes(data.provider)
  ) {
    if (!data.baseUrl || data.baseUrl.trim() === "") {
      return "baseUrl is required for this provider";
    }
  }

  if (data.apiPath !== undefined && data.apiPath.trim() !== "") {
    const apiPath = data.apiPath.trim();
    if (
      !apiPath.startsWith("/") ||
      !apiPath.toLowerCase().endsWith("/chat/completions")
    ) {
      return "apiPath must start with / and end with /chat/completions";
    }
  }

  if (data.modality && !["chat", "image", "video"].includes(data.modality)) {
    return `Invalid modality: ${data.modality}`;
  }

  return null;
}

async function getGithubCopilotModelForConnection(
  token: { apiToken: string; baseUrl: string },
  model?: string,
): Promise<string> {
  const selectedModel = model?.trim();
  if (selectedModel) return selectedModel;

  try {
    const models = await fetchGithubCopilotModels({
      apiToken: token.apiToken,
      baseUrl: token.baseUrl,
    });
    return models[0]?.value || GITHUB_COPILOT_DEFAULT_MODEL;
  } catch {
    return GITHUB_COPILOT_DEFAULT_MODEL;
  }
}

export function disconnectGithubCopilotConfig(id: string): LlmConfigResult {
  try {
    const config = getLlmConfig(id);
    if (!config) {
      return { error: "Selected LLM configuration does not exist" };
    }
    if (config.provider !== "github-copilot") {
      return { error: "Selected LLM configuration is not GitHub Copilot" };
    }

    updateLlmConfig(id, {
      apiKey: "",
      enabled: false,
      lastCheckedAt: null,
      lastCheckStatus: null,
      lastCheckMessage: "GitHub Copilot disconnected",
    });
    return (
      getLlmConfig(id) ?? {
        error: "Selected LLM configuration does not exist",
      }
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function completeGithubCopilotConnection(
  payload: CompleteGithubCopilotPayload,
): Promise<LlmConfigResult> {
  try {
    const existing = payload.configId ? getLlmConfig(payload.configId) : null;
    if (payload.configId && !existing) {
      return { error: "Selected LLM configuration does not exist" };
    }
    if (existing && existing.provider !== "github-copilot") {
      return { error: "Selected LLM configuration is not GitHub Copilot" };
    }

    const token = await completeGithubCopilotDeviceFlow({
      deviceCode: payload.deviceCode,
    });
    const model = await getGithubCopilotModelForConnection(
      token,
      payload.model,
    );
    const now = new Date().toISOString();

    if (existing) {
      updateLlmConfig(existing.id, {
        name: payload.name?.trim() || existing.name,
        apiKey: token.apiToken,
        baseUrl: token.baseUrl,
        apiPath: "/chat/completions",
        model,
        modality: "chat",
        enabled: true,
        lastCheckedAt: now,
        lastCheckStatus: "success",
        lastCheckMessage: "GitHub Copilot connected",
      });
      return (
        getLlmConfig(existing.id) ?? {
          error: "Selected LLM configuration does not exist",
        }
      );
    }

    return createLlmConfig({
      name: payload.name?.trim() || "GitHub Copilot",
      provider: "github-copilot",
      apiKey: token.apiToken,
      baseUrl: token.baseUrl,
      apiPath: "/chat/completions",
      model,
      modality: "chat",
      enabled: true,
      isDefault: false,
      lastCheckedAt: now,
      lastCheckStatus: "success",
      lastCheckMessage: "GitHub Copilot connected",
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
        apiPath: data.apiPath?.trim() || null,
        model,
        modality: data.modality ?? "chat",
        enabled: data.enabled ?? true,
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
          if (
            updates.apiPath !== undefined &&
            updates.apiPath !== null &&
            updates.apiPath.trim() !== "" &&
            (!updates.apiPath.trim().startsWith("/") ||
              !updates.apiPath
                .trim()
                .toLowerCase()
                .endsWith("/chat/completions"))
          ) {
            return {
              error: "apiPath must start with / and end with /chat/completions",
            };
          }
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

  ipcMain.handle("llm-config:test", async (_event, payload: { id: string }) => {
    try {
      const config = getLlmConfig(payload.id);
      if (!config) {
        return { error: "Selected LLM configuration does not exist" };
      }

      const result = await testLlmConfigConnection(config);
      updateLlmConfig(config.id, {
        lastCheckedAt: new Date().toISOString(),
        lastCheckStatus: result.status,
        lastCheckMessage: result.message,
      });
      return getLlmConfig(config.id);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("llm-config:copilot:start", async () => {
    try {
      return await startGithubCopilotDeviceFlow();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    "llm-config:copilot:models",
    async (_event, payload: { id: string }) => {
      try {
        const config = getLlmConfig(payload.id);
        if (!config) {
          return { error: "Selected LLM configuration does not exist" };
        }
        if (config.provider !== "github-copilot") {
          return {
            error: "Selected LLM configuration is not GitHub Copilot",
          };
        }
        if (!config.apiKey) {
          return { error: "GitHub Copilot token is missing" };
        }

        return await fetchGithubCopilotModels({
          apiToken: config.apiKey,
          baseUrl: config.baseUrl,
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "llm-config:copilot:complete",
    async (_event, payload: CompleteGithubCopilotPayload) =>
      completeGithubCopilotConnection(payload),
  );

  ipcMain.handle(
    "llm-config:copilot:disconnect",
    async (_event, payload: { id: string }) =>
      disconnectGithubCopilotConfig(payload.id),
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
