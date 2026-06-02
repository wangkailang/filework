/**
 * 媒体 IPC 处理器 —— 面向非 chat 类 LLM 配置的图像/视频生成。
 *
 * 路由由 `llmConfig.modality` 决定:
 *   - modality === "image" → MiniMax /v1/image_generation,同步
 *   - modality === "video" → MiniMax /v1/video_generation,异步(由 watcher 轮询)
 *
 * 生成的产物存放在 ~/.filework/generated/{sessionId}/ 下,
 * 避免污染用户仓库。渲染进程通过现有的
 * `local-file://` 自定义协议进行渲染。
 */

import { ipcMain } from "electron";

import { generateImage } from "../ai/minimax/image-client";
import { MinimaxApiError } from "../ai/minimax/types";
import { submitVideo } from "../ai/minimax/video-client";
import {
  createMediaJob,
  getLlmConfig,
  getMediaJob,
  type LlmConfig,
  listActiveMediaJobs,
  updateMediaJob,
} from "../db";
import { mediaJobWatcher } from "./media-job-watcher";
import { saveMediaToDisk } from "./media-storage";

interface MediaHandlerDeps {
  fetchFn: typeof fetch;
}

let deps: MediaHandlerDeps | null = null;

interface GenerateImagePayload {
  llmConfigId: string;
  sessionId: string;
  prompt: string;
  /** 可选的 MiniMax aspect_ratio(例如 "1:1"、"16:9")。 */
  aspectRatio?: string;
}

interface GenerateImageOk {
  /** 已保存图像在磁盘上的绝对路径。 */
  path: string;
  /** 回传给渲染进程,使其无需第二次 IPC 即可渲染。 */
  prompt: string;
  configId: string;
  /** 随机短 id —— 用作 message-part 的 key。 */
  imageId: string;
}

type GenerateImageResult = GenerateImageOk | { error: string };

/**
 * 任何媒体生成请求的通用前置校验。校验通过时返回收窄后的
 * config;否则返回可直接通过 IPC 返回的 `{error}` 负载。集中处理,
 * 使图像与视频处理器保持一致
 * —— 新增一种 modality(音频、声音克隆……)只需多加一个分支。
 */
const validateMediaConfig = (
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

const handleGenerateImage = async (
  payload: GenerateImagePayload,
): Promise<GenerateImageResult> => {
  if (!deps) return { error: "media handlers not initialized" };

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
      fetchImpl: deps.fetchFn,
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
      deps.fetchFn,
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
  };
};

// ────────────────────────────────────────────────────────────────────
// 视频生成(Phase 3)—— 异步,由 watcher 驱动
// ────────────────────────────────────────────────────────────────────

interface CreateVideoJobPayload {
  llmConfigId: string;
  sessionId: string;
  prompt: string;
}

interface CreateVideoJobOk {
  jobId: string;
  status: "queued";
  configId: string;
  prompt: string;
  modelId: string;
}

type CreateVideoJobResult = CreateVideoJobOk | { error: string };

/**
 * 每个任务对应一个 AbortController。渲染进程的取消按钮 → 写入 DB +
 * 这里的 `abort()`,watcher 会监听该信号。任务在 watcher 内
 * 终结时清除。
 */
const jobAbortControllers = new Map<string, AbortController>();

const handleCreateVideoJob = async (
  payload: CreateVideoJobPayload,
  sender: Electron.WebContents,
): Promise<CreateVideoJobResult> => {
  if (!deps) return { error: "media handlers not initialized" };

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
      fetchImpl: deps.fetchFn,
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
    // watcher 在任意终止路径(成功 / 失败 / 超时 / 中止)下都会
    // 调用此回调,因此 controller Map 不会随已完成任务而无限增长。
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

const handleCancelJob = (jobId: string): { canceled: boolean } => {
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

export const registerMediaHandlers = (init: MediaHandlerDeps): void => {
  deps = init;
  ipcMain.handle(
    "media:generate-image",
    async (_event, payload: GenerateImagePayload) => {
      try {
        return await handleGenerateImage(payload);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "media:create-video-job",
    async (event, payload: CreateVideoJobPayload) => {
      try {
        return await handleCreateVideoJob(payload, event.sender);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "media:cancel-job",
    async (_event, payload: { jobId: string }) => {
      return handleCancelJob(payload.jobId);
    },
  );

  ipcMain.handle("media:list-active-jobs", async () => {
    return listActiveMediaJobs();
  });
};
