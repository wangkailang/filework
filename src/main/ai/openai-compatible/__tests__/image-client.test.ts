import { describe, expect, it, vi } from "vitest";

import {
  generateOpenAICompatibleImage,
  OpenAICompatibleImageError,
} from "../image-client";

describe("generateOpenAICompatibleImage", () => {
  it("posts to the OpenAI-compatible images endpoint and normalizes b64 output to a data URL", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: "aW1hZ2U=" }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const result = await generateOpenAICompatibleImage({
      apiKey: "sk-test",
      apiPath: "/v1/chat/completions",
      baseUrl: "https://gateway.example.com",
      fetchImpl: fetchFn,
      model: "gpt-image-2",
      prompt: "生成一张图",
    });

    expect(result).toEqual({
      imageUrls: ["data:image/png;base64,aW1hZ2U="],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://gateway.example.com/v1/images/generations",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-image-2",
          n: 1,
          prompt: "生成一张图",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        }),
        method: "POST",
      }),
    );
  });

  it("surfaces upstream error messages", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "model not found" } }),
          { status: 404, statusText: "Not Found" },
        ),
    ) as unknown as typeof fetch;

    await expect(
      generateOpenAICompatibleImage({
        baseUrl: "https://gateway.example.com/v1",
        fetchImpl: fetchFn,
        model: "gpt-image-2",
        prompt: "生成一张图",
      }),
    ).rejects.toThrow(OpenAICompatibleImageError);
  });
});
