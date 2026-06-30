import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  countOpenAIResponsesInputTokens,
  supportsOpenAIResponsesInputTokenCount,
} from "../provider-token-count";

const officialOpenAIConfig = {
  provider: "openai",
  apiKey: "test-key",
  baseUrl: null,
  model: "gpt-5.5",
  modelCapabilities: {
    preferredApi: "responses" as const,
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: true,
  },
};

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

describe("OpenAI Responses input token count", () => {
  it("calls the official input token endpoint for supported OpenAI configs", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ object: "response.input_tokens", input_tokens: 1234 }),
    );
    const messages: ModelMessage[] = [
      { role: "system", content: "You are a workspace agent." },
      { role: "user", content: "介绍下项目" },
    ];

    const result = await countOpenAIResponsesInputTokens(
      officialOpenAIConfig,
      messages,
      { fetch: fetchMock as typeof fetch },
    );

    expect(result).toEqual({
      accuracy: "actual",
      inputTokens: 1234,
      provider: "openai",
      source: "openai-responses-input-tokens",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses/input_tokens",
      expect.objectContaining({ method: "POST" }),
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "gpt-5.5",
      input: [
        {
          role: "developer",
          content: "You are a workspace agent.",
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "介绍下项目" }],
        },
      ],
    });
  });

  it("converts assistant tool calls and tool results into Responses input items", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ object: "response.input_tokens", input_tokens: 5678 }),
    );
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先搜索文件。" },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "searchFiles",
            input: { query: "words_alpha" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "searchFiles",
            output: { type: "text", value: "words_alpha.txt" },
          },
        ],
      },
    ];

    await countOpenAIResponsesInputTokens(officialOpenAIConfig, messages, {
      fetch: fetchMock as typeof fetch,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string).input).toEqual([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "我先搜索文件。" }],
      },
      {
        type: "function_call",
        call_id: "call_123",
        name: "searchFiles",
        arguments: JSON.stringify({ query: "words_alpha" }),
      },
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "words_alpha.txt",
      },
    ]);
  });

  it("skips OpenAI-compatible custom endpoints so they keep local estimates", async () => {
    const fetchMock = vi.fn();
    const config = {
      ...officialOpenAIConfig,
      baseUrl: "https://gateway.example.com/v1",
    };

    expect(supportsOpenAIResponsesInputTokenCount(config)).toBe(false);
    await expect(
      countOpenAIResponsesInputTokens(
        config,
        [{ role: "user", content: "hi" }],
        { fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
