/**
 * MiniMax 视频生成客户端。
 *
 * 视频生成是异步的:
 *   1. POST /v1/video_generation        → task_id(立即返回)
 *   2. GET  /v1/query/video_generation  → status;最终得到 file_id
 *   3. GET  /v1/files/retrieve          → 短时效的签名下载 URL
 *
 * 这里每次调用都是一次性的 HTTP 往返。轮询循环放在
 * `src/main/ipc/media-job-watcher.ts`,以保持本模块纯净且易于测试。
 */

import { resolveMinimaxBaseUrl } from "./chat-base-url";
import { ensureOk, ensureZeroStatus } from "./fetch-utils";
import {
  MinimaxApiError,
  type MinimaxFileRetrieveResponse,
  type MinimaxVideoQueryResponse,
  type MinimaxVideoStatus,
  type MinimaxVideoSubmitResponse,
} from "./types";

interface CommonInput {
  apiKey: string;
  baseUrl?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SubmitVideoInput extends CommonInput {
  model: string;
  prompt: string;
  /** 可选的首帧参考图,可以是 URL 或 base64 data URL。 */
  firstFrameImage?: string;
}

export interface SubmitVideoResult {
  taskId: string;
}

export const submitVideo = async (
  input: SubmitVideoInput,
): Promise<SubmitVideoResult> => {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = `${resolveMinimaxBaseUrl(input.baseUrl)}/video_generation`;

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
  };
  if (input.firstFrameImage) body.first_frame_image = input.firstFrameImage;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  await ensureOk(response, "video_generation");

  const json = (await response.json()) as MinimaxVideoSubmitResponse;
  ensureZeroStatus(json.base_resp, "video_generation", response.status);
  if (!json.task_id) {
    throw new MinimaxApiError(
      "MiniMax video_generation returned no task_id",
      0,
      response.status,
    );
  }
  return { taskId: json.task_id };
};

export interface QueryVideoInput extends CommonInput {
  taskId: string;
}

export interface QueryVideoResult {
  status: MinimaxVideoStatus;
  fileId: string | null;
}

export const queryVideo = async (
  input: QueryVideoInput,
): Promise<QueryVideoResult> => {
  const fetchFn = input.fetchImpl ?? fetch;
  const base = resolveMinimaxBaseUrl(input.baseUrl);
  const url = `${base}/query/video_generation?task_id=${encodeURIComponent(input.taskId)}`;

  const response = await fetchFn(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: input.signal,
  });
  await ensureOk(response, "query/video_generation");

  const json = (await response.json()) as MinimaxVideoQueryResponse;
  ensureZeroStatus(json.base_resp, "query/video_generation", response.status);
  if (!json.status) {
    throw new MinimaxApiError(
      "MiniMax query/video_generation returned no status",
      0,
      response.status,
    );
  }
  return { status: json.status, fileId: json.file_id ?? null };
};

export interface RetrieveFileInput extends CommonInput {
  fileId: string;
}

export interface RetrieveFileResult {
  downloadUrl: string;
  filename: string | null;
  bytes: number | null;
}

export const retrieveFile = async (
  input: RetrieveFileInput,
): Promise<RetrieveFileResult> => {
  const fetchFn = input.fetchImpl ?? fetch;
  const base = resolveMinimaxBaseUrl(input.baseUrl);
  const url = `${base}/files/retrieve?file_id=${encodeURIComponent(input.fileId)}`;

  const response = await fetchFn(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: input.signal,
  });
  await ensureOk(response, "files/retrieve");

  const json = (await response.json()) as MinimaxFileRetrieveResponse;
  ensureZeroStatus(json.base_resp, "files/retrieve", response.status);
  const dl = json.file?.download_url;
  if (!dl) {
    throw new MinimaxApiError(
      "MiniMax files/retrieve returned no download_url",
      0,
      response.status,
    );
  }
  return {
    downloadUrl: dl,
    filename: json.file?.filename ?? null,
    bytes: json.file?.bytes ?? null,
  };
};
