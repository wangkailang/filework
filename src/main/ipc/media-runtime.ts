/**
 * 媒体生成运行时 —— 图像 / 视频 modality 的主进程执行入口。
 *
 * IPC handler 与 ai:executeTask 共用这里的函数,避免 renderer 为
 * 非 chat 配置单独绕过任务运行时。视频 watcher 的 AbortController
 * 也集中管理,保证“取消生成”不只改 DB 状态,还会停止后台轮询。
 */

import type { WebContents } from "electron";

import { generateImage } from "../ai/minimax/image-client";
import { MinimaxApiError } from "../ai/minimax/types";
import { submitVideo } from "../ai/minimax/video-client";
import {
  createMediaJob,
  getLlmConfig,
  getMediaJob,
  type LlmConfig,
  updateMediaJob,
} from "../db";
import { mediaJobWatcher } from "./media-job-watcher";
import { saveMediaToDisk } from "./media-storage";

export interface MediaRuntimeDeps {
  fetchFn: typeof fetch;
}

let deps: MediaRuntimeDeps | null = null;

export const configureMediaRuntime = (init: MediaRuntimeDeps): void => {
  deps = init;
};

export interface GenerateImagePayload {
  llmConfigId: string;
  sessionId: string;
  prompt: string;
  /** 可选的 MiniMax aspect_ratio(例如 "1:1"、"16:9")。 */
  aspectRatio?: string;
  signal?: AbortSignal;
}

interface GenerateImageOk {
  /** 已保存图像在磁盘上的绝对路径。 */
  path: string;
  /** 回传给渲染进程,使其无需第二次 IPC 即可渲染。 */
  prompt: string;
  configId: string;
  /** 随机短 id —— 用作 message-part 的 key。 */
  imageId: string;
  modelId: string;
}

export type GenerateImageResult = GenerateImageOk | { error: string };

export interface CreateVideoJobPayload {
  llmConfigId: string;
  sessionId: string;
  prompt: string;
  signal?: AbortSignal;
}

interface CreateVideoJobOk {
  jobId: string;
  status: "queued";
  configId: string;
  prompt: string;
  modelId: string;
}

export type CreateVideoJobResult = CreateVideoJobOk | { error: string };

const jobAbortControllers = new Map<string, AbortController>();

const requireDeps = (): MediaRuntimeDeps | { error: string } => {
  if (!deps) return { error: "media runtime not initialized" };
  return deps;
};

/**
 * 任何媒体生成请求的通用前置校验。校验通过时返回收窄后的
 * config;否则返回可直接通过 IPC / stream-error 返回的 `{error}`。
 */
export const validateMediaConfig = (
  llmConfigId: string,
  expectedModality: "image" | "video",
  prompt: string,
): { ok: true; config: LlmConfig & { apiKey: string } } | { error: string } => {
  const config = getLlmConfig(llmConfigId);
  if (!config) return { error: "LLM config not found" };
  if (config.modality !== expectedModality) {
    return {
      error: `LLM config modality is "${config.modality}", expected "${expectedModality}"`,
    };
  }
  if (config.provider !== "minimax") {
    return {
      error: `Provider "${config.provider}" ${expectedModality} generation is not implemented (only MiniMax for now)`,
    };
  }
  if (!config.apiKey) return { error: "LLM config has no API key" };
  if (!prompt || prompt.trim() === "") {
    return { error: "prompt is required" };
  }
  return { ok: true, config: { ...config, apiKey: config.apiKey } };
};

export const generateImageForConfig = async (
  payload: GenerateImagePayload,
): Promise<GenerateImageResult> => {
  const runtimeDeps = requireDeps();
  if ("error" in runtimeDeps) return runtimeDeps;

  const validation = validateMediaConfig(
    payload.llmConfigId,
    "image",
    payload.prompt,
  );
  if ("error" in validation) return validation;
  const { config } = validation;

  let imageUrls: string[];
  try {
    const result = await generateImage({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      prompt: payload.prompt,
      aspectRatio: payload.aspectRatio,
      signal: payload.signal,
      fetchImpl: runtimeDeps.fetchFn,
    });
    imageUrls = result.imageUrls;
  } catch (err) {
    if (err instanceof MinimaxApiError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const firstUrl = imageUrls[0];
  if (!firstUrl) return { error: "MiniMax returned no image URLs" };

  let saved: { path: string; shortId: string };
  try {
    saved = await saveMediaToDisk(
      runtimeDeps.fetchFn,
      firstUrl,
      payload.sessionId,
      "png",
    );
  } catch (err) {
    return {
      error: `Failed to download generated image: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    path: saved.path,
    prompt: payload.prompt,
    configId: payload.llmConfigId,
    imageId: saved.shortId,
    modelId: config.model,
  };
};

export const createVideoJobForConfig = async (
  payload: CreateVideoJobPayload,
  sender: WebContents,
): Promise<CreateVideoJobResult> => {
  const runtimeDeps = requireDeps();
  if ("error" in runtimeDeps) return runtimeDeps;

  const validation = validateMediaConfig(
    payload.llmConfigId,
    "video",
    payload.prompt,
  );
  if ("error" in validation) return validation;
  const { config } = validation;

  let providerTaskId: string;
  try {
    const { taskId } = await submitVideo({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      prompt: payload.prompt,
      signal: payload.signal,
      fetchImpl: runtimeDeps.fetchFn,
    });
    providerTaskId = taskId;
  } catch (err) {
    return {
      error:
        err instanceof MinimaxApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  const job = createMediaJob({
    sessionId: payload.sessionId,
    configId: payload.llmConfigId,
    kind: "video",
    providerJobId: providerTaskId,
    prompt: payload.prompt,
    status: "queued",
  });

  const controller = new AbortController();
  jobAbortControllers.set(job.id, controller);
  mediaJobWatcher.subscribe({
    jobId: job.id,
    sender,
    signal: controller.signal,
    onUnsubscribe: (id) => {
      jobAbortControllers.delete(id);
    },
  });

  return {
    jobId: job.id,
    status: "queued",
    configId: payload.llmConfigId,
    prompt: payload.prompt,
    modelId: config.model,
  };
};

export const cancelMediaJob = (jobId: string): { canceled: boolean } => {
  const job = getMediaJob(jobId);
  if (!job) return { canceled: false };
  if (
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "canceled"
  ) {
    return { canceled: false };
  }
  updateMediaJob(jobId, {
    status: "canceled",
    completedAt: new Date().toISOString(),
  });
  const controller = jobAbortControllers.get(jobId);
  if (controller) {
    controller.abort();
    jobAbortControllers.delete(jobId);
  }
  return { canceled: true };
};
