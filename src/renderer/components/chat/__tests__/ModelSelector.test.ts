import { describe, expect, it } from "vitest";

import {
  getDisplayLlmConfigModality,
  getSelectableLlmConfigs,
  resolveDisplayedLlmConfig,
} from "../ModelSelector";

describe("getSelectableLlmConfigs", () => {
  it("only keeps enabled LLM configs with successful connection checks", () => {
    expect(
      getSelectableLlmConfigs([
        {
          id: "enabled",
          name: "Enabled model",
          provider: "custom",
          model: "gpt-4o-mini",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "success",
        },
        {
          id: "legacy-success",
          name: "Legacy successful model",
          provider: "custom",
          model: "legacy-model",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "success",
          modelAvailable: null,
        },
        {
          id: "model-unavailable",
          name: "Unavailable model",
          provider: "github-copilot",
          model: "removed-model",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "success",
          modelAvailable: false,
        },
        {
          id: "disabled",
          name: "Disabled model",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: false,
          lastCheckStatus: "success",
        },
        {
          id: "connection-error",
          name: "Connection error",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "error",
        },
        {
          id: "untested",
          name: "Untested model",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: true,
          lastCheckStatus: null,
        },
      ]).map((config) => config.id),
    ).toEqual(["enabled", "legacy-success"]);
  });
});

describe("resolveDisplayedLlmConfig", () => {
  it("shows the default chat config when no explicit config is selected", () => {
    const displayed = resolveDisplayedLlmConfig(
      [
        {
          id: "recent",
          name: "Recently updated model",
          provider: "openai",
          model: "gpt-5.5",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "success",
        },
        {
          id: "default-chat",
          name: "Default chat",
          provider: "deepseek",
          model: "deepseek-chat",
          modality: "chat",
          enabled: true,
          isDefault: true,
          lastCheckStatus: "success",
        },
      ],
      null,
    );

    expect(displayed?.id).toBe("default-chat");
  });

  it("keeps an explicit selectable config even when another config is default", () => {
    const displayed = resolveDisplayedLlmConfig(
      [
        {
          id: "default-chat",
          name: "Default chat",
          provider: "deepseek",
          model: "deepseek-chat",
          modality: "chat",
          enabled: true,
          isDefault: true,
          lastCheckStatus: "success",
        },
        {
          id: "selected",
          name: "Selected model",
          provider: "openai",
          model: "gpt-5.5",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "success",
        },
      ],
      "selected",
    );

    expect(displayed?.id).toBe("selected");
  });
});

describe("getDisplayLlmConfigModality", () => {
  it("groups legacy OpenAI-compatible gpt-image configs as image even when stored as chat", () => {
    expect(
      getDisplayLlmConfigModality({
        provider: "custom",
        model: "gpt-image-2",
        modality: "chat",
      }),
    ).toBe("image");
  });

  it("keeps explicit non-chat modalities and regular chat models unchanged", () => {
    expect(
      getDisplayLlmConfigModality({
        provider: "minimax",
        model: "MiniMax-Hailuo-02",
        modality: "video",
      }),
    ).toBe("video");
    expect(
      getDisplayLlmConfigModality({
        provider: "custom",
        model: "gpt-5.5",
        modality: "chat",
      }),
    ).toBe("chat");
  });
});
