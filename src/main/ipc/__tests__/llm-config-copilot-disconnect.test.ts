import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeGithubCopilotConnection,
  disconnectGithubCopilotConfig,
} from "../llm-config-handlers";

const dbMock = vi.hoisted(() => ({
  createLlmConfig: vi.fn(),
  deleteLlmConfig: vi.fn(),
  getLlmConfig: vi.fn(),
  getLlmConfigs: vi.fn(),
  setDefaultLlmConfig: vi.fn(),
  updateLlmConfig: vi.fn(),
}));

const copilotMock = vi.hoisted(() => ({
  completeGithubCopilotDeviceFlow: vi.fn(),
  fetchGithubCopilotModels: vi.fn(),
  startGithubCopilotDeviceFlow: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock("../../db", () => dbMock);

vi.mock("../github-copilot-auth", () => copilotMock);

vi.mock("../llm-config-connection", () => ({
  testLlmConfigConnection: vi.fn(),
}));

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
});
