import { ipcMain } from "electron";
import type { LlmConfig, LlmModality } from "../db";
import {
  createLlmConfig,
  deleteLlmConfig,
  getLlmConfig,
  getLlmConfigs,
  replaceLlmModelCatalog,
  setDefaultLlmConfig,
  updateLlmConfig,
} from "../db";
import {
  completeGithubCopilotDeviceFlow,
  fetchGithubCopilotModels,
  type GithubCopilotModelOption,
  serializeGithubCopilotAuthMetadata,
  startGithubCopilotDeviceFlow,
} from "./github-copilot-auth";
import { getFreshGithubCopilotSessionToken } from "./github-copilot-session";
import {
  type LlmConnectionTestResult,
  testLlmConfigConnection,
} from "./llm-config-connection";
import {
  fetchOpenAICompatibleModels,
  type LlmModelOption,
} from "./llm-config-models";

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
type GithubCopilotSessionToken = Awaited<
  ReturnType<typeof getFreshGithubCopilotSessionToken>
>;

function formatLlmConnectionCheckMessage(
  result: LlmConnectionTestResult,
): string {
  if (!result.diagnostics) return result.message;
  const { diagnostics } = result;
  const status =
    diagnostics.statusCode === null
      ? "No HTTP response"
      : `HTTP ${diagnostics.statusCode}`;
  return [
    result.message,
    `${diagnostics.method} ${diagnostics.url}`,
    `${status} · ${diagnostics.durationMs}ms · ${diagnostics.model}`,
  ].join("\n");
}

function cacheLlmModelCatalog(
  configId: string,
  models: LlmModelOption[],
): void {
  replaceLlmModelCatalog(
    configId,
    models.map((model) => ({
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      label: model.label,
      maxOutputTokens: model.maxOutputTokens,
      modelId: model.value,
    })),
    new Date().toISOString(),
  );
}

async function refreshModelCatalogForConfig(
  config: LlmConfig,
  copilotToken?: GithubCopilotSessionToken,
): Promise<void> {
  if (config.provider === "github-copilot") {
    const token =
      copilotToken ??
      (await getFreshGithubCopilotSessionToken({
        configId: config.id,
      }));
    const models = await fetchGithubCopilotModels({
      apiToken: token.apiToken,
      baseUrl: token.baseUrl,
    });
    cacheLlmModelCatalog(config.id, models);
    return;
  }

  if (config.provider === "custom") {
    const models = await fetchOpenAICompatibleModels({
      apiKey: config.apiKey,
      apiPath: config.apiPath,
      baseUrl: config.baseUrl,
    });
    cacheLlmModelCatalog(config.id, models);
  }
}

async function refreshModelCatalogAfterSuccessfulConnection(
  config: LlmConfig,
  result: LlmConnectionTestResult,
  copilotToken?: GithubCopilotSessionToken,
): Promise<void> {
  if (result.status !== "success") return;
  try {
    await refreshModelCatalogForConfig(config, copilotToken);
  } catch {
    // Model discovery is best-effort: a successful chat probe should not become
    // a failed connection merely because the provider does not expose /models.
  }
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
      authMetadata: null,
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
    const authMetadata = serializeGithubCopilotAuthMetadata({
      version: 1,
      githubAccessToken: token.githubAccessToken,
      copilotToken: token.apiToken,
      copilotTokenExpiresAt: token.expiresAt,
      baseUrl: token.baseUrl,
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
        authMetadata,
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
      authMetadata,
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

export async function testLlmConfigById(id: string): Promise<LlmConfigResult> {
  const config = getLlmConfig(id);
  if (!config) {
    return { error: "Selected LLM configuration does not exist" };
  }

  let copilotToken: GithubCopilotSessionToken | undefined;
  if (config.provider === "github-copilot") {
    copilotToken = await getFreshGithubCopilotSessionToken({
      configId: config.id,
    });
  }

  const configForTest = copilotToken
    ? {
        ...config,
        apiKey: copilotToken.apiToken,
        baseUrl: copilotToken.baseUrl,
      }
    : config;

  const result = await testLlmConfigConnection(configForTest);
  updateLlmConfig(config.id, {
    lastCheckedAt: new Date().toISOString(),
    lastCheckStatus: result.status,
    lastCheckMessage: formatLlmConnectionCheckMessage(result),
  });
  await refreshModelCatalogAfterSuccessfulConnection(
    configForTest,
    result,
    copilotToken,
  );
  return (
    getLlmConfig(config.id) ?? {
      error: "Selected LLM configuration does not exist",
    }
  );
}

export async function listGithubCopilotModelsForConfig(
  id: string,
): Promise<GithubCopilotModelOption[] | { error: string }> {
  const config = getLlmConfig(id);
  if (!config) {
    return { error: "Selected LLM configuration does not exist" };
  }
  if (config.provider !== "github-copilot") {
    return {
      error: "Selected LLM configuration is not GitHub Copilot",
    };
  }

  const token = await getFreshGithubCopilotSessionToken({
    configId: config.id,
  });
  const models = await fetchGithubCopilotModels({
    apiToken: token.apiToken,
    baseUrl: token.baseUrl,
  });
  cacheLlmModelCatalog(config.id, models);
  return models;
}

export async function listLlmModelsForConfig(
  id: string,
): Promise<LlmModelOption[] | { error: string }> {
  const config = getLlmConfig(id);
  if (!config) {
    return { error: "Selected LLM configuration does not exist" };
  }
  if (config.provider === "github-copilot") {
    return listGithubCopilotModelsForConfig(id);
  }
  if (config.provider !== "custom") {
    return {
      error: "Selected LLM configuration does not support model discovery",
    };
  }

  const models = await fetchOpenAICompatibleModels({
    apiKey: config.apiKey,
    apiPath: config.apiPath,
    baseUrl: config.baseUrl,
  });
  cacheLlmModelCatalog(config.id, models);
  return models;
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
      return await testLlmConfigById(payload.id);
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
        return await listGithubCopilotModelsForConfig(payload.id);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "llm-config:models",
    async (_event, payload: { id: string }) => {
      try {
        return await listLlmModelsForConfig(payload.id);
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
