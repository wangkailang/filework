import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeGithubCopilotConnection,
  disconnectGithubCopilotConfig,
  listGithubCopilotModelsForConfig,
  listLlmModelsForConfig,
  testLlmConfigById,
} from "../llm-config-handlers";

const dbMock = vi.hoisted(() => ({
  createLlmConfig: vi.fn(),
  deleteLlmConfig: vi.fn(),
  getLlmConfig: vi.fn(),
  getLlmConfigs: vi.fn(),
  replaceLlmModelCatalog: vi.fn(),
  setDefaultLlmConfig: vi.fn(),
  updateLlmConfig: vi.fn(),
}));

const copilotMock = vi.hoisted(() => ({
  completeGithubCopilotDeviceFlow: vi.fn(),
  fetchGithubCopilotModels: vi.fn(),
  serializeGithubCopilotAuthMetadata: vi.fn((metadata: unknown) =>
    JSON.stringify(metadata),
  ),
  startGithubCopilotDeviceFlow: vi.fn(),
}));

const sessionMock = vi.hoisted(() => ({
  getFreshGithubCopilotSessionToken: vi.fn(),
}));

const connectionMock = vi.hoisted(() => ({
  testLlmConfigConnection: vi.fn(),
}));

const modelMock = vi.hoisted(() => ({
  fetchOpenAICompatibleModels: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock("../../db", () => dbMock);

vi.mock("../github-copilot-auth", () => copilotMock);

vi.mock("../github-copilot-session", () => sessionMock);

vi.mock("../llm-config-connection", () => connectionMock);

vi.mock("../llm-config-models", () => modelMock);

const connectedCopilotConfig = {
  id: "copilot-1",
  name: "GitHub Copilot",
  provider: "github-copilot" as const,
  apiKey: "copilot-token",
  baseUrl: "https://api.githubcopilot.com",
  apiPath: "/chat/completions",
  model: "gpt-5.5",
  modality: "chat" as const,
  isDefault: false,
  enabled: true,
  lastCheckedAt: "2026-06-22T00:00:00.000Z",
  lastCheckStatus: "success" as const,
  lastCheckMessage: "GitHub Copilot connected",
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

const customConfig = {
  ...connectedCopilotConfig,
  id: "custom-1",
  name: "Gateway",
  provider: "custom" as const,
  apiKey: "sk-gateway",
  baseUrl: "https://gateway.example.com",
  apiPath: "/v1/chat/completions",
  model: "openai/gpt-4o-mini",
};

describe("GitHub Copilot LLM config connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects Copilot by clearing its token and disabling the config", () => {
    dbMock.getLlmConfig
      .mockReturnValueOnce(connectedCopilotConfig)
      .mockReturnValueOnce({
        ...connectedCopilotConfig,
        apiKey: null,
        enabled: false,
        lastCheckStatus: null,
        lastCheckMessage: "GitHub Copilot disconnected",
      });

    const result = disconnectGithubCopilotConfig("copilot-1");

    expect(dbMock.updateLlmConfig).toHaveBeenCalledWith("copilot-1", {
      apiKey: "",
      authMetadata: null,
      enabled: false,
      lastCheckedAt: null,
      lastCheckStatus: null,
      lastCheckMessage: "GitHub Copilot disconnected",
    });
    expect(result).toMatchObject({
      id: "copilot-1",
      apiKey: null,
      enabled: false,
      lastCheckMessage: "GitHub Copilot disconnected",
    });
  });

  it("reconnects a disconnected Copilot config by updating the same config", async () => {
    dbMock.getLlmConfig
      .mockReturnValueOnce({
        ...connectedCopilotConfig,
        apiKey: null,
        enabled: false,
      })
      .mockReturnValueOnce({
        ...connectedCopilotConfig,
        apiKey: "new-copilot-token",
        enabled: true,
      });
    copilotMock.completeGithubCopilotDeviceFlow.mockResolvedValue({
      apiToken: "new-copilot-token",
      baseUrl: "https://api.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
      githubAccessToken: "gho-new",
    });
    copilotMock.fetchGithubCopilotModels.mockResolvedValue([
      { value: "gpt-5.5", label: "GPT-5.5" },
    ]);

    const result = await completeGithubCopilotConnection({
      configId: "copilot-1",
      deviceCode: "device-123",
    });

    expect(dbMock.createLlmConfig).not.toHaveBeenCalled();
    expect(dbMock.updateLlmConfig).toHaveBeenCalledWith(
      "copilot-1",
      expect.objectContaining({
        apiKey: "new-copilot-token",
        apiPath: "/chat/completions",
        authMetadata: expect.stringContaining("gho-new"),
        baseUrl: "https://api.githubcopilot.com",
        enabled: true,
        model: "gpt-5.5",
      }),
    );
    expect(result).toMatchObject({
      id: "copilot-1",
      apiKey: "new-copilot-token",
      enabled: true,
    });
  });

  it("refreshes the session token before listing Copilot models", async () => {
    dbMock.getLlmConfig.mockReturnValue(connectedCopilotConfig);
    sessionMock.getFreshGithubCopilotSessionToken.mockResolvedValue({
      apiToken: "fresh-session-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
    });
    copilotMock.fetchGithubCopilotModels.mockResolvedValue([
      {
        value: "claude-sonnet-4.6",
        label: "Claude Sonnet 4.6",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: null,
          supportsTools: true,
          supportsVision: null,
        },
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    ]);

    const result = await listGithubCopilotModelsForConfig("copilot-1");

    expect(result).toEqual([
      {
        value: "claude-sonnet-4.6",
        label: "Claude Sonnet 4.6",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: null,
          supportsTools: true,
          supportsVision: null,
        },
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    ]);
    expect(dbMock.replaceLlmModelCatalog).toHaveBeenCalledWith(
      "copilot-1",
      [
        {
          capabilities: {
            preferredApi: "chat_completions",
            supportsReasoning: null,
            supportsTools: true,
            supportsVision: null,
          },
          contextWindow: 200000,
          label: "Claude Sonnet 4.6",
          maxOutputTokens: 64000,
          modelId: "claude-sonnet-4.6",
        },
      ],
      expect.any(String),
    );
    expect(sessionMock.getFreshGithubCopilotSessionToken).toHaveBeenCalledWith({
      configId: "copilot-1",
    });
    expect(copilotMock.fetchGithubCopilotModels).toHaveBeenCalledWith({
      apiToken: "fresh-session-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
  });

  it("fetches and caches OpenAI-compatible model catalogs", async () => {
    dbMock.getLlmConfig.mockReturnValue(customConfig);
    modelMock.fetchOpenAICompatibleModels.mockResolvedValue([
      {
        value: "openai/gpt-4o-mini",
        label: "GPT-4o mini",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: null,
          supportsTools: true,
          supportsVision: true,
        },
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
    ]);

    const result = await listLlmModelsForConfig("custom-1");

    expect(result).toEqual([
      {
        value: "openai/gpt-4o-mini",
        label: "GPT-4o mini",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: null,
          supportsTools: true,
          supportsVision: true,
        },
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
    ]);
    expect(modelMock.fetchOpenAICompatibleModels).toHaveBeenCalledWith({
      apiKey: "sk-gateway",
      apiPath: "/v1/chat/completions",
      baseUrl: "https://gateway.example.com",
    });
    expect(dbMock.replaceLlmModelCatalog).toHaveBeenCalledWith(
      "custom-1",
      [
        {
          capabilities: {
            preferredApi: "chat_completions",
            supportsReasoning: null,
            supportsTools: true,
            supportsVision: true,
          },
          contextWindow: 128000,
          label: "GPT-4o mini",
          maxOutputTokens: 16384,
          modelId: "openai/gpt-4o-mini",
        },
      ],
      expect.any(String),
    );
  });

  it("refreshes OpenAI-compatible model catalogs after successful connection tests", async () => {
    dbMock.getLlmConfig.mockReturnValueOnce(customConfig).mockReturnValueOnce({
      ...customConfig,
      lastCheckStatus: "success",
      modelAvailable: true,
    });
    connectionMock.testLlmConfigConnection.mockResolvedValue({
      status: "success",
      message: "Connection OK",
      diagnostics: {
        checkedAt: "2026-06-22T08:00:00.000Z",
        durationMs: 42,
        method: "POST",
        model: "openai/gpt-4o-mini",
        provider: "custom",
        statusCode: 200,
        url: "https://gateway.example.com/v1/chat/completions",
      },
    });
    modelMock.fetchOpenAICompatibleModels.mockResolvedValue([
      {
        value: "openai/gpt-4o-mini",
        label: "GPT-4o mini",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: null,
          supportsTools: true,
          supportsVision: true,
        },
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
    ]);

    const result = await testLlmConfigById("custom-1");

    expect(result).toMatchObject({
      id: "custom-1",
      modelAvailable: true,
    });
    expect(modelMock.fetchOpenAICompatibleModels).toHaveBeenCalledWith({
      apiKey: "sk-gateway",
      apiPath: "/v1/chat/completions",
      baseUrl: "https://gateway.example.com",
    });
    expect(dbMock.replaceLlmModelCatalog).toHaveBeenCalledWith(
      "custom-1",
      [
        {
          capabilities: {
            preferredApi: "chat_completions",
            supportsReasoning: null,
            supportsTools: true,
            supportsVision: true,
          },
          contextWindow: 128000,
          label: "GPT-4o mini",
          maxOutputTokens: 16384,
          modelId: "openai/gpt-4o-mini",
        },
      ],
      expect.any(String),
    );
  });

  it("refreshes the session token before testing a Copilot connection", async () => {
    dbMock.getLlmConfig
      .mockReturnValueOnce(connectedCopilotConfig)
      .mockReturnValueOnce({
        ...connectedCopilotConfig,
        lastCheckStatus: "success",
      });
    sessionMock.getFreshGithubCopilotSessionToken.mockResolvedValue({
      apiToken: "fresh-session-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: "2026-06-22T08:00:00.000Z",
    });
    connectionMock.testLlmConfigConnection.mockResolvedValue({
      status: "success",
      message: "Connection OK",
      diagnostics: {
        checkedAt: "2026-06-22T08:00:00.000Z",
        durationMs: 42,
        method: "POST",
        model: "gpt-5.5",
        provider: "github-copilot",
        statusCode: 200,
        url: "https://api.individual.githubcopilot.com/chat/completions",
      },
    });

    const result = await testLlmConfigById("copilot-1");

    expect(connectionMock.testLlmConfigConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "fresh-session-token",
        baseUrl: "https://api.individual.githubcopilot.com",
      }),
    );
    expect(dbMock.updateLlmConfig).toHaveBeenCalledWith(
      "copilot-1",
      expect.objectContaining({
        lastCheckStatus: "success",
        lastCheckMessage:
          "Connection OK\nPOST https://api.individual.githubcopilot.com/chat/completions\nHTTP 200 · 42ms · gpt-5.5",
      }),
    );
    expect(result).toMatchObject({ id: "copilot-1" });
  });
});
