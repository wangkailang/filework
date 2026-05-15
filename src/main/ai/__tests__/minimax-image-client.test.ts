import { describe, expect, it, vi } from "vitest";

import { generateImage } from "../minimax/image-client";
import { MinimaxApiError } from "../minimax/types";

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("minimax image-client", () => {
  it("returns urls on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        id: "req-1",
        data: { image_urls: ["https://cdn.example.com/a.png"] },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;

    const result = await generateImage({
      apiKey: "sk-test",
      model: "image-01",
      prompt: "a robot",
      fetchImpl,
    });

    expect(result.imageUrls).toEqual(["https://cdn.example.com/a.png"]);
    expect(result.requestId).toBe("req-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("image-01");
    expect(body.response_format).toBe("url");
    expect(body.n).toBe(1);
  });

  it("uses the override base URL and strips trailing slash", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        data: { image_urls: ["https://cdn.example.com/b.png"] },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;

    await generateImage({
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io/v1/",
      model: "image-01",
      prompt: "x",
      fetchImpl,
    });
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.minimax.io/v1/image_generation");
  });

  it("throws MinimaxApiError on non-zero status_code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        data: {},
        base_resp: { status_code: 1004, status_msg: "auth failed" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      generateImage({
        apiKey: "bad",
        model: "image-01",
        prompt: "x",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(MinimaxApiError);
  });

  it("throws on HTTP error status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("server error", { status: 500 }),
      ) as unknown as typeof fetch;

    await expect(
      generateImage({
        apiKey: "sk",
        model: "image-01",
        prompt: "x",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(MinimaxApiError);
  });

  it("throws when API returns empty image_urls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        data: { image_urls: [] },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      generateImage({
        apiKey: "sk",
        model: "image-01",
        prompt: "x",
        fetchImpl,
      }),
    ).rejects.toThrow(/no image URLs/);
  });
});
