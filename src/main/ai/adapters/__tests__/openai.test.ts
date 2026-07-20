import { describe, expect, it, vi } from "vitest";

const openAiMock = vi.hoisted(() => {
  const responsesModel = { kind: "responses-model" };
  const chatModel = { kind: "chat-model" };
  const responses = vi.fn(() => responsesModel);
  const chat = vi.fn(() => chatModel);
  const createOpenAI = vi.fn(() => Object.assign(responses, { chat }));
  return { chat, chatModel, createOpenAI, responses, responsesModel };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

import { buildGithubCopilotFetch, OpenAIAdapter } from "../openai";

describe("OpenAIAdapter API selection", () => {
  it("uses Responses API when an OpenAI-compatible model catalog prefers responses", () => {
    vi.clearAllMocks();
    const adapter = new OpenAIAdapter();

    const model = adapter.createModel({
      provider: "custom",
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      apiPath: "/chat/completions",
      model: "gpt-5.5",
      modelCapabilities: {
        preferredApi: "responses",
        supportsReasoning: true,
        supportsTools: true,
        supportsVision: null,
      },
    });

    expect(model).toBe(openAiMock.responsesModel);
    expect(openAiMock.responses).toHaveBeenCalledWith("gpt-5.5");
    expect(openAiMock.chat).not.toHaveBeenCalled();
  });

  it("keeps Chat Completions for OpenAI-compatible models that prefer chat_completions", () => {
    vi.clearAllMocks();
    const adapter = new OpenAIAdapter();

    const model = adapter.createModel({
      provider: "github-copilot",
      apiKey: "test-key",
      baseUrl: "https://api.githubcopilot.com",
      apiPath: "/chat/completions",
      model: "claude-sonnet-4.6",
      modelCapabilities: {
        preferredApi: "chat_completions",
        supportsReasoning: null,
        supportsTools: true,
        supportsVision: null,
      },
    });

    expect(model).toBe(openAiMock.chatModel);
    expect(openAiMock.chat).toHaveBeenCalledWith("claude-sonnet-4.6");
    expect(openAiMock.responses).not.toHaveBeenCalled();
  });
});

describe("OpenAIAdapter provider options", () => {
  it("enables native compaction for official OpenAI Responses models", () => {
    const adapter = new OpenAIAdapter();

    expect(
      adapter.buildProviderOptions({
        provider: "openai",
        apiKey: "test-key",
        baseUrl: null,
        compressionTriggerBudget: 735_000,
        model: "gpt-5.5",
        modelCapabilities: {
          preferredApi: "responses",
          supportsReasoning: true,
          supportsTools: true,
          supportsVision: true,
        },
      }),
    ).toEqual({
      openai: {
        parallelToolCalls: false,
        contextManagement: [
          {
            type: "compaction",
            compactThreshold: 735_000,
          },
        ],
      },
    });
  });

  it("does not send native compaction to custom OpenAI-compatible endpoints", () => {
    const adapter = new OpenAIAdapter();

    expect(
      adapter.buildProviderOptions({
        provider: "custom",
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        compressionTriggerBudget: 735_000,
        model: "gpt-5.5",
        modelCapabilities: {
          preferredApi: "responses",
          supportsReasoning: true,
          supportsTools: true,
          supportsVision: true,
        },
      }),
    ).toEqual({
      openai: {
        parallelToolCalls: false,
      },
    });
  });

  it("omits reasoning effort when the selected model is known not to support reasoning", () => {
    const adapter = new OpenAIAdapter();

    expect(
      adapter.buildProviderOptions({
        provider: "custom",
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        reasoningEffort: "high",
        modelCapabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: false,
          supportsTools: true,
          supportsVision: true,
        },
      }),
    ).toEqual({
      openai: {
        parallelToolCalls: false,
      },
    });
  });
});

describe("OpenAIAdapter GitHub Copilot fetch", () => {
  it("overrides Authorization with a fresh Copilot session token", async () => {
    const providerFetch = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    const resolveApiKey = vi.fn(async () => "fresh-session-token");
    const copilotFetch = buildGithubCopilotFetch(providerFetch, resolveApiKey);

    await copilotFetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer stale-token",
      },
    });

    expect(resolveApiKey).toHaveBeenCalledWith();
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.githubcopilot.com/chat/completions",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = providerFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer fresh-session-token");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
    expect(headers.get("Editor-Version")).toBe("filework/0.1.0");
  });

  it("retries once with a forced refresh when Copilot rejects the cached token", async () => {
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const resolveApiKey = vi
      .fn()
      .mockResolvedValueOnce("cached-session-token")
      .mockResolvedValueOnce("forced-session-token");
    const copilotFetch = buildGithubCopilotFetch(providerFetch, resolveApiKey);

    const response = await copilotFetch(
      "https://api.githubcopilot.com/chat/completions",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(resolveApiKey).toHaveBeenNthCalledWith(1);
    expect(resolveApiKey).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    const retryHeaders = providerFetch.mock.calls[1]?.[1]?.headers as Headers;
    expect(retryHeaders.get("Authorization")).toBe(
      "Bearer forced-session-token",
    );
  });
});
