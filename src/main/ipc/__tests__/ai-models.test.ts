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
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 8192,
    reasoningEffort: "medium",
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
      adapter: { buildProviderOptions: () => ({}) },
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

  it("passes provider-native compaction trigger metadata into the adapter", () => {
    const selected = makeConfig({
      id: "selected",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      modelContextWindow: 200_000,
      maxOutputTokens: 8_000,
    });
    dbMock.getLlmConfig.mockReturnValue(selected);
    dbMock.getLlmConfigs.mockReturnValue([selected]);
    adapterMock.createModelWithAdapter.mockReturnValue({
      model: "model",
      adapter: { buildProviderOptions: () => ({}) },
    });

    const result = getModelAndAdapterByConfigId("selected");

    expect(result.providerNativeCompaction).toEqual({
      enabled: true,
      mode: "anthropic-context-management-compact",
      provider: "anthropic",
      triggerTokens: 170_000,
    });
    expect(adapterMock.createModelWithAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        compressionTriggerBudget: 170_000,
        maxOutputTokens: 8_000,
        modelContextWindow: 200_000,
      }),
    );
  });

  it("returns advanced generation options from the selected config", () => {
    const selected = makeConfig({
      id: "selected",
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 4096,
      reasoningEffort: "high",
    });
    dbMock.getLlmConfig.mockReturnValue(selected);
    dbMock.getLlmConfigs.mockReturnValue([selected]);
    adapterMock.createModelWithAdapter.mockReturnValue({
      model: "model",
      adapter: { buildProviderOptions: () => ({}) },
    });

    const result = getModelAndAdapterByConfigId("selected");

    expect(result.generationOptions).toEqual({
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 4096,
      reasoningEffort: "high",
    });
  });
});
