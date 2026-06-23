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

import { listActiveMediaJobs } from "../db";
import {
  type CreateVideoJobPayload,
  cancelMediaJob,
  configureMediaRuntime,
  createVideoJobForConfig,
  type GenerateImagePayload,
  generateImageForConfig,
} from "./media-runtime";

interface MediaHandlerDeps {
  fetchFn: typeof fetch;
}

export const registerMediaHandlers = (init: MediaHandlerDeps): void => {
  configureMediaRuntime(init);
  ipcMain.handle(
    "media:generate-image",
    async (_event, payload: GenerateImagePayload) => {
      try {
        return await generateImageForConfig(payload);
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
        return await createVideoJobForConfig(payload, event.sender);
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
      return cancelMediaJob(payload.jobId);
    },
  );

  ipcMain.handle("media:list-active-jobs", async () => {
    return listActiveMediaJobs();
  });
};
