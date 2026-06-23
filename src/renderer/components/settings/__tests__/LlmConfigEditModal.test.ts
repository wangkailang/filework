import { describe, expect, it } from "vitest";

import {
  formatLlmModelOptionLabel,
  getGithubCopilotAuthStepStates,
  getLlmProviderFieldPolicy,
  getLlmReasoningEffortAvailability,
  getLlmSelectedModelAvailability,
  getVisibleLlmModelOptions,
  shouldShowGithubCopilotAuthFlow,
  shouldShowGithubCopilotDisconnect,
} from "../LlmConfigEditModal";

describe("getLlmProviderFieldPolicy", () => {
  it("shows optional API key and required Base URL for OpenAI-compatible custom providers", () => {
    expect(getLlmProviderFieldPolicy("custom")).toEqual({
      showApiKey: true,
      requireApiKey: false,
      showBaseUrl: true,
      requireBaseUrl: true,
      showApiPath: true,
      supportsImageVideo: false,
      baseUrlPlaceholder: "https://api.example.com/v1",
      apiPathPlaceholder: "/chat/completions",
    });
  });

  it("uses GitHub Copilot device auth instead of a manual API key", () => {
    expect(getLlmProviderFieldPolicy("github-copilot")).toEqual({
      showApiKey: false,
      requireApiKey: false,
      showBaseUrl: true,
      requireBaseUrl: true,
      showApiPath: true,
      supportsImageVideo: false,
      baseUrlPlaceholder: "https://api.githubcopilot.com",
      apiPathPlaceholder: "/chat/completions",
    });
  });

  it("uses refreshed GitHub Copilot model options from the API", () => {
    const refreshedModels = [
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    ];

    expect(
      getVisibleLlmModelOptions("github-copilot", refreshedModels, "gpt-5.5"),
    ).toEqual(refreshedModels);
    expect(
      getVisibleLlmModelOptions("github-copilot", refreshedModels, "legacy-id"),
    ).toEqual([{ value: "legacy-id", label: "legacy-id" }, ...refreshedModels]);
    expect(
      getVisibleLlmModelOptions("custom", refreshedModels, "gpt-5.5"),
    ).toEqual(refreshedModels);
    expect(
      getVisibleLlmModelOptions("openai", refreshedModels, "gpt-5.5"),
    ).toEqual([]);
  });

  it("adds compact capability hints to refreshed model labels", () => {
    expect(
      formatLlmModelOptionLabel({
        value: "gpt-5.5",
        label: "GPT-5.5",
        capabilities: {
          preferredApi: "responses",
          supportsReasoning: true,
          supportsTools: true,
          supportsVision: null,
        },
        contextWindow: 200000,
        maxOutputTokens: 64000,
      }),
    ).toBe("GPT-5.5 · Responses · Reasoning · Tools · 200k ctx");
  });

  it("detects when refreshed model catalogs no longer include the selected model", () => {
    const refreshedModels = [
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    ];

    expect(
      getLlmSelectedModelAvailability(
        "github-copilot",
        refreshedModels,
        "legacy-id",
      ),
    ).toBe("unavailable");
    expect(
      getLlmSelectedModelAvailability(
        "custom",
        refreshedModels,
        "claude-sonnet-4.6",
      ),
    ).toBe("available");
    expect(getLlmSelectedModelAvailability("custom", [], "legacy-id")).toBe(
      "unknown",
    );
    expect(
      getLlmSelectedModelAvailability("openai", refreshedModels, "gpt-5.5"),
    ).toBe("unknown");
  });

  it("detects when refreshed model metadata does not support reasoning effort", () => {
    const refreshedModels = [
      {
        value: "gpt-4o-mini",
        label: "GPT-4o mini",
        capabilities: {
          preferredApi: "chat_completions" as const,
          supportsReasoning: false,
          supportsTools: true,
          supportsVision: true,
        },
      },
      {
        value: "gpt-5.5",
        label: "GPT-5.5",
        capabilities: {
          preferredApi: "responses" as const,
          supportsReasoning: true,
          supportsTools: true,
          supportsVision: null,
        },
      },
    ];

    expect(
      getLlmReasoningEffortAvailability(
        "custom",
        refreshedModels,
        "gpt-4o-mini",
      ),
    ).toBe("unsupported");
    expect(
      getLlmReasoningEffortAvailability("custom", refreshedModels, "gpt-5.5"),
    ).toBe("supported");
    expect(
      getLlmReasoningEffortAvailability("custom", [], "future-model"),
    ).toBe("unknown");
  });

  it("shows reconnect auth flow after an existing Copilot config is disconnected", () => {
    expect(
      shouldShowGithubCopilotAuthFlow("github-copilot", false, false),
    ).toBe(true);
    expect(shouldShowGithubCopilotAuthFlow("github-copilot", true, false)).toBe(
      true,
    );
    expect(shouldShowGithubCopilotAuthFlow("github-copilot", true, true)).toBe(
      false,
    );
    expect(
      shouldShowGithubCopilotDisconnect("github-copilot", true, true),
    ).toBe(true);
    expect(
      shouldShowGithubCopilotDisconnect("github-copilot", true, false),
    ).toBe(false);
  });

  it("marks Copilot auth steps according to device-code progress", () => {
    expect(getGithubCopilotAuthStepStates(false)).toEqual([
      "current",
      "locked",
      "locked",
      "locked",
    ]);
    expect(getGithubCopilotAuthStepStates(true)).toEqual([
      "done",
      "current",
      "current",
      "current",
    ]);
  });
});
