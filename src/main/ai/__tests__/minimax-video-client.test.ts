import { describe, expect, it, vi } from "vitest";

import { MinimaxApiError } from "../minimax/types";
import { queryVideo, retrieveFile, submitVideo } from "../minimax/video-client";

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("minimax video-client", () => {
  it("submitVideo returns task_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        task_id: "task-abc",
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;
    const result = await submitVideo({
      apiKey: "sk",
      model: "MiniMax-Hailuo-02",
      prompt: "a cat",
      fetchImpl,
    });
    expect(result.taskId).toBe("task-abc");
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/video_generation");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("submitVideo throws when API returns no task_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;
    await expect(
      submitVideo({ apiKey: "sk", model: "x", prompt: "y", fetchImpl }),
    ).rejects.toBeInstanceOf(MinimaxApiError);
  });

  it("queryVideo returns status + fileId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        task_id: "task-abc",
        status: "Success",
        file_id: "file-xyz",
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;
    const result = await queryVideo({
      apiKey: "sk",
      taskId: "task-abc",
      fetchImpl,
    });
    expect(result.status).toBe("Success");
    expect(result.fileId).toBe("file-xyz");
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      "https://api.minimaxi.com/v1/query/video_generation?task_id=task-abc",
    );
  });

  it("queryVideo returns Processing without fileId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        task_id: "task-abc",
        status: "Processing",
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;
    const result = await queryVideo({
      apiKey: "sk",
      taskId: "task-abc",
      fetchImpl,
    });
    expect(result.status).toBe("Processing");
    expect(result.fileId).toBeNull();
  });

  it("retrieveFile returns download_url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        file: {
          file_id: "file-xyz",
          filename: "video.mp4",
          bytes: 1024,
          download_url: "https://cdn.example.com/v.mp4?sig=x",
        },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    ) as unknown as typeof fetch;
    const result = await retrieveFile({
      apiKey: "sk",
      fileId: "file-xyz",
      fetchImpl,
    });
    expect(result.downloadUrl).toBe("https://cdn.example.com/v.mp4?sig=x");
    expect(result.filename).toBe("video.mp4");
    expect(result.bytes).toBe(1024);
  });

  it("propagates non-zero status_code as MinimaxApiError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        base_resp: { status_code: 2013, status_msg: "invalid model" },
      }),
    ) as unknown as typeof fetch;
    await expect(
      submitVideo({ apiKey: "sk", model: "bad", prompt: "y", fetchImpl }),
    ).rejects.toBeInstanceOf(MinimaxApiError);
  });
});
