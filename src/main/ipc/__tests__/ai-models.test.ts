import { describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../../db";

const dbMock = vi.hoisted(() => ({
  getLlmConfig: vi.fn(),
  getLlmConfigs: vi.fn(),
}));

const adapterMock = vi.hoisted(() => ({
  createModelWithAdapter: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock("../../db", () => dbMock);

vi.mock("../../ai/adapters", () => adapterMock);

vi.mock("../github-copilot-session", () => ({
  getFreshGithubCopilotSessionToken: vi.fn(),
}));

import {
  getModelAndAdapterByConfigId,
  selectAvailableChatLlmConfig,
} from "../ai-models";

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: "cfg-1",
    name: "Config",
    provider: "custom" as const,
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    apiPath: "/chat/completions",
    model: "gpt-5.5",
    modality: "chat" as const,
    isDefault: false,
    enabled: true,
    lastCheckedAt: "2026-06-22T07:00:00.000Z",
    lastCheckStatus: "success" as const,
    lastCheckMessage: "ok",
    modelAvailable: true,
    modelCapabilities: {
      preferredApi: "responses" as const,
      supportsReasoning: true,
      supportsTools: true,
      supportsVision: null,
    },
    modelCatalogFetchedAt: "2026-06-22T07:00:00.000Z",
    createdAt: "2026-06-22T07:00:00.000Z",
    updatedAt: "2026-06-22T07:00:00.000Z",
    ...overrides,
  };
}

describe("ai-models LLM config selection", () => {
  it("uses the requested config when it is available", () => {
    const selected = makeConfig({ id: "selected" });
    dbMock.getLlmConfig.mockReturnValue(selected);
    dbMock.getLlmConfigs.mockReturnValue([selected]);

    expect(selectAvailableChatLlmConfig("selected")).toEqual({
      config: selected,
      fallbackFromConfigId: null,
    });
  });

  it("falls back to the newest available chat config when the requested one is not usable", () => {
    const selected = makeConfig({
      id: "selected",
      lastCheckStatus: "error",
    });
    const fallback = makeConfig({
      id: "fallback",
      updatedAt: "2026-06-22T08:00:00.000Z",
    });
    const disabled = makeConfig({
      id: "disabled",
      enabled: false,
      updatedAt: "2026-06-22T09:00:00.000Z",
    });
    dbMock.getLlmConfig.mockReturnValue(selected);
    dbMock.getLlmConfigs.mockReturnValue([disabled, fallback, selected]);

    expect(selectAvailableChatLlmConfig("selected")).toEqual({
      config: fallback,
      fallbackFromConfigId: "selected",
    });
  });

  it("fails clearly when there is no available chat config", () => {
    dbMock.getLlmConfig.mockReturnValue(null);
    dbMock.getLlmConfigs.mockReturnValue([
      makeConfig({ id: "untested", lastCheckStatus: null }),
      makeConfig({ id: "image", modality: "image" }),
      makeConfig({ id: "removed", modelAvailable: false }),
    ]);

    expect(() => selectAvailableChatLlmConfig("missing")).toThrow(
      /没有可用的聊天 LLM 配置/,
    );
  });

  it("passes cached model capabilities into the provider adapter", () => {
    const selected = makeConfig({ id: "selected" });
    dbMock.getLlmConfig.mockReturnValue(selected);
    dbMock.getLlmConfigs.mockReturnValue([selected]);
    adapterMock.createModelWithAdapter.mockReturnValue({
      model: "model",
      adapter: "adapter",
    });

    const result = getModelAndAdapterByConfigId("selected");

    expect(result.modelId).toBe("gpt-5.5");
    expect(result.configId).toBe("selected");
    expect(adapterMock.createModelWithAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        modelCapabilities: selected.modelCapabilities,
      }),
    );
  });
});
