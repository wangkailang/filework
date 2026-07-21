import { describe, expect, it, vi } from "vitest";

import {
  fetchOpenAICompatibleModels,
  inferLlmModelCapabilities,
} from "../llm-config-models";

describe("inferLlmModelCapabilities", () => {
  it("marks known non-reasoning chat models as not supporting reasoning effort", () => {
    expect(
      inferLlmModelCapabilities("openai/gpt-4o-mini").supportsReasoning,
    ).toBe(false);
    expect(inferLlmModelCapabilities("deepseek-chat").supportsReasoning).toBe(
      false,
    );
  });

  it("marks DeepSeek V4 models as supporting reasoning", () => {
    expect(inferLlmModelCapabilities("deepseek-v4-pro").supportsReasoning).toBe(
      true,
    );
    expect(
      inferLlmModelCapabilities("deepseek-v4-flash").supportsReasoning,
    ).toBe(true);
  });
});

describe("fetchOpenAICompatibleModels", () => {
  it("fetches /models from the resolved OpenAI-compatible base URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-4o-mini",
                name: "GPT-4o mini",
                context_window: 128000,
                max_output_tokens: 16384,
              },
              { id: "gpt-5.5", name: "GPT-5.5" },
            ],
          }),
        ),
    );

    const result = await fetchOpenAICompatibleModels(
      {
        apiKey: "sk-test",
        apiPath: "/v1/chat/completions",
        baseUrl: "https://gateway.example.com",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer sk-test",
        }),
      }),
    );
    expect(result).toEqual([
      {
        value: "openai/gpt-4o-mini",
        label: "GPT-4o mini",
        capabilities: {
          preferredApi: "chat_completions",
          supportsReasoning: false,
          supportsTools: true,
          supportsVision: true,
        },
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
      {
        value: "gpt-5.5",
        label: "GPT-5.5",
        capabilities: {
          preferredApi: "responses",
          supportsReasoning: true,
          supportsTools: true,
          supportsVision: null,
        },
        contextWindow: null,
        maxOutputTokens: null,
      },
    ]);
  });
});
