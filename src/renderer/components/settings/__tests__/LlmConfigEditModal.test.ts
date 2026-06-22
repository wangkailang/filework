import { describe, expect, it } from "vitest";

import {
  getLlmProviderFieldPolicy,
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
    ).toEqual([]);
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
});
