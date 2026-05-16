/**
 * Media IPC handlers — image/video generation for non-chat LLM configs.
 *
 * Routing is gated by `llmConfig.modality`:
 *   - modality === "image" → MiniMax /v1/image_generation, sync
 *   - modality === "video" → MiniMax /v1/video_generation, async (watcher polls)
 *
 * Generated artifacts live under ~/.filework/generated/{sessionId}/ so
 * they don't pollute user repos. The renderer renders them via the
 * existing `local-file://` custom protocol.
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
  /** Optional MiniMax aspect_ratio (e.g. "1:1", "16:9"). */
  aspectRatio?: string;
}

interface GenerateImageOk {
  /** Absolute path on disk to the saved image. */
  path: string;
  /** Echoed back so the renderer can render without a second IPC. */
  prompt: string;
  configId: string;
  /** Random short id — used as the message-part key. */
  imageId: string;
}

type GenerateImageResult = GenerateImageOk | { error: string };

/**
 * Common pre-flight checks for any media-generation request. Returns a
 * narrowed config when valid; otherwise an `{error}` payload ready to
 * IPC-return. Centralised so image and video handlers stay in lockstep
 * — adding a new modality (audio, voice clone…) is one extra branch.
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
// Video generation (Phase 3) — async, watcher-driven
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
 * Per-job AbortController. The renderer's cancel button → DB write +
 * `abort()` here, which the watcher listens to. Cleared on job finalize
 * inside the watcher.
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
    // Watcher invokes this on any terminal path (success / fail / timeout
    // / abort), so the controller Map doesn't grow with completed jobs.
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
