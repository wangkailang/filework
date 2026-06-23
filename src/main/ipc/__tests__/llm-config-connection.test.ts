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

  it("posts a minimal OpenAI-compatible image generation request for image configs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), {
          status: 200,
        }),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "custom",
        apiKey: "sk-test",
        baseUrl: "https://gateway.example.com",
        apiPath: "/v1/chat/completions",
        model: "gpt-image-2",
        modality: "image",
      },
      fetchImpl,
    );
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(result).toMatchObject({
      status: "success",
      message: "Connection OK",
      diagnostics: {
        method: "POST",
        model: "gpt-image-2",
        provider: "custom",
        statusCode: 200,
        url: "https://gateway.example.com/v1/images/generations",
      },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "gpt-image-2",
      n: 1,
      prompt: "ping",
    });
  });

  it("posts a minimal MiniMax image_generation request for MiniMax image configs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: { image_urls: ["https://cdn.example.com/image.png"] },
            base_resp: { status_code: 0, status_msg: "ok" },
          }),
          { status: 200 },
        ),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "minimax",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io/v1",
        apiPath: null,
        model: "image-01",
        modality: "image",
      },
      fetchImpl,
    );
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(result).toMatchObject({
      status: "success",
      diagnostics: {
        method: "POST",
        model: "image-01",
        provider: "minimax",
        statusCode: 200,
        url: "https://api.minimax.io/v1/image_generation",
      },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "image-01",
      n: 1,
      prompt: "ping",
      response_format: "url",
    });
  });

  it("posts a minimal MiniMax video_generation request for MiniMax video configs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            task_id: "task-1",
            base_resp: { status_code: 0, status_msg: "ok" },
          }),
          { status: 200 },
        ),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "minimax",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io/v1",
        apiPath: null,
        model: "MiniMax-Hailuo-02",
        modality: "video",
      },
      fetchImpl,
    );
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(result).toMatchObject({
      status: "success",
      diagnostics: {
        method: "POST",
        model: "MiniMax-Hailuo-02",
        provider: "minimax",
        statusCode: 200,
        url: "https://api.minimax.io/v1/video_generation",
      },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "MiniMax-Hailuo-02",
      prompt: "ping",
    });
  });

  it("returns an error when MiniMax media probes return a non-zero base_resp status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            base_resp: { status_code: 2013, status_msg: "invalid model" },
          }),
          { status: 200 },
        ),
    );

    const result = await testLlmConfigConnection(
      {
        provider: "minimax",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io/v1",
        apiPath: null,
        model: "bad-image-model",
        modality: "image",
      },
      fetchImpl,
    );

    expect(result).toMatchObject({
      status: "error",
      message: "MiniMax media probe failed (2013): invalid model",
      diagnostics: {
        method: "POST",
        model: "bad-image-model",
        provider: "minimax",
        statusCode: 200,
        url: "https://api.minimax.io/v1/image_generation",
      },
    });
  });
});
