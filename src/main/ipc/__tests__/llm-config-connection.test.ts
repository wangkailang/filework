import { describe, expect, it, vi } from "vitest";

import { testLlmConfigConnection } from "../llm-config-connection";

describe("testLlmConfigConnection", () => {
  it("posts a minimal OpenAI-compatible chat completion to the configured API path", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "custom",
        apiKey: "sk-test",
        baseUrl: "https://gateway.example.com",
        apiPath: "/v1/chat/completions",
        model: "gpt-4o-mini",
        modality: "chat",
      },
      fetchImpl,
    );
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(result.status).toBe("success");
    expect(result.diagnostics).toMatchObject({
      durationMs: expect.any(Number),
      method: "POST",
      model: "gpt-4o-mini",
      provider: "custom",
      statusCode: 200,
      url: "https://gateway.example.com/v1/chat/completions",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("returns an error status with provider response detail when the probe fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "custom",
        apiKey: "sk-test",
        baseUrl: "https://gateway.example.com/v1",
        apiPath: null,
        model: "gpt-4o-mini",
        modality: "chat",
      },
      fetchImpl,
    );

    expect(result).toMatchObject({
      status: "error",
      message: "HTTP 401: bad key",
      diagnostics: {
        method: "POST",
        model: "gpt-4o-mini",
        provider: "custom",
        statusCode: 401,
        url: "https://gateway.example.com/v1/chat/completions",
      },
    });
  });

  it("adds GitHub Copilot headers when probing a Copilot config", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "github-copilot",
        apiKey: "copilot-token",
        baseUrl: "https://api.githubcopilot.com",
        apiPath: "/chat/completions",
        model: "gpt-5.5",
        modality: "chat",
      },
      fetchImpl,
    );

    expect(result.status).toBe("success");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.githubcopilot.com/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer copilot-token",
          "Content-Type": "application/json",
          "Copilot-Integration-Id": "vscode-chat",
          "Editor-Version": "filework/0.1.0",
          "User-Agent": "Filework",
        }),
      }),
    );
  });
});
