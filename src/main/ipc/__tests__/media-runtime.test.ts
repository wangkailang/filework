import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  createMediaJob: vi.fn(),
  getLlmConfig: vi.fn(),
  getMediaJob: vi.fn(),
  updateMediaJob: vi.fn(),
}));

const imageClientMock = vi.hoisted(() => ({
  generateImage: vi.fn(),
}));

const videoClientMock = vi.hoisted(() => ({
  submitVideo: vi.fn(),
}));

const storageMock = vi.hoisted(() => ({
  saveMediaToDisk: vi.fn(),
}));

const watcherMock = vi.hoisted(() => ({
  mediaJobWatcher: {
    subscribe: vi.fn(),
  },
}));

vi.mock("../../db", () => dbMock);

vi.mock("../../ai/minimax/image-client", () => imageClientMock);

vi.mock("../../ai/minimax/video-client", () => videoClientMock);

vi.mock("../media-job-watcher", () => watcherMock);

vi.mock("../media-storage", () => storageMock);

import {
  cancelMediaJob,
  configureMediaRuntime,
  createVideoJobForConfig,
  generateImageForConfig,
} from "../media-runtime";

function makeConfig(modality: "image" | "video") {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.minimax.io/v1",
    id: `${modality}-cfg`,
    modality,
    model: `${modality}-model`,
    provider: "minimax",
  };
}

describe("media-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureMediaRuntime({ fetchFn: vi.fn() as unknown as typeof fetch });
  });

  it("generates and stores image output for an image config", async () => {
    const signal = new AbortController().signal;
    dbMock.getLlmConfig.mockReturnValue(makeConfig("image"));
    imageClientMock.generateImage.mockResolvedValue({
      imageUrls: ["https://cdn.example/image.png"],
    });
    storageMock.saveMediaToDisk.mockResolvedValue({
      path: "/tmp/generated/image.png",
      shortId: "img-1",
    });

    const result = await generateImageForConfig({
      aspectRatio: "1:1",
      llmConfigId: "image-cfg",
      prompt: "生成一张图",
      sessionId: "session-1",
      signal,
    });

    expect(result).toEqual({
      configId: "image-cfg",
      imageId: "img-1",
      modelId: "image-model",
      path: "/tmp/generated/image.png",
      prompt: "生成一张图",
    });
    expect(imageClientMock.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        aspectRatio: "1:1",
        baseUrl: "https://api.minimax.io/v1",
        model: "image-model",
        prompt: "生成一张图",
        signal,
      }),
    );
    expect(storageMock.saveMediaToDisk).toHaveBeenCalledWith(
      expect.any(Function),
      "https://cdn.example/image.png",
      "session-1",
      "png",
    );
  });

  it("creates a video job and cancels the shared watcher controller", async () => {
    const watcherSignals: AbortSignal[] = [];
    dbMock.getLlmConfig.mockReturnValue(makeConfig("video"));
    dbMock.createMediaJob.mockReturnValue({
      id: "job-1",
      status: "queued",
    });
    dbMock.getMediaJob.mockReturnValue({
      id: "job-1",
      status: "queued",
    });
    videoClientMock.submitVideo.mockResolvedValue({ taskId: "provider-job-1" });
    watcherMock.mediaJobWatcher.subscribe.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => {
        watcherSignals.push(signal);
        return true;
      },
    );
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    } as never;

    const result = await createVideoJobForConfig(
      {
        llmConfigId: "video-cfg",
        prompt: "生成视频",
        sessionId: "session-1",
      },
      sender,
    );

    expect(result).toEqual({
      configId: "video-cfg",
      jobId: "job-1",
      modelId: "video-model",
      prompt: "生成视频",
      status: "queued",
    });
    expect(videoClientMock.submitVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io/v1",
        model: "video-model",
        prompt: "生成视频",
      }),
    );
    expect(dbMock.createMediaJob).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "video-cfg",
        kind: "video",
        prompt: "生成视频",
        providerJobId: "provider-job-1",
        sessionId: "session-1",
        status: "queued",
      }),
    );
    const signal = watcherSignals[0];
    expect(signal).toBeDefined();
    if (!signal) throw new Error("expected watcher signal");
    expect(signal.aborted).toBe(false);

    expect(cancelMediaJob("job-1")).toEqual({ canceled: true });

    expect(dbMock.updateMediaJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "canceled" }),
    );
    expect(signal.aborted).toBe(true);
  });
});
