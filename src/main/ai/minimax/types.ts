/**
 * MiniMax 非对话类 API(图像 / 视频生成)的共用类型。
 *
 * 对话走 OpenAI 兼容的 /v1/chat/completions 端点,经由 OpenAIAdapter ——
 * 这些类型只覆盖专用端点
 * (/v1/image_generation、/v1/video_generation、/v1/query/...)。
 */

export interface MinimaxBaseResp {
  status_code: number;
  status_msg: string;
}

/** POST /v1/image_generation 的响应结构。 */
export interface MinimaxImageResponse {
  id?: string;
  data?: {
    image_urls?: string[];
  };
  metadata?: Record<string, unknown>;
  base_resp: MinimaxBaseResp;
}

// ─── 视频生成 ───────────────────────────────────────────────

/** /v1/query/video_generation 返回的服务端状态。 */
export type MinimaxVideoStatus =
  | "Queueing"
  | "Preparing"
  | "Processing"
  | "Success"
  | "Fail";

/** POST /v1/video_generation 的响应结构。 */
export interface MinimaxVideoSubmitResponse {
  task_id?: string;
  base_resp: MinimaxBaseResp;
}

/** GET /v1/query/video_generation?task_id=... 的响应结构。 */
export interface MinimaxVideoQueryResponse {
  task_id?: string;
  status?: MinimaxVideoStatus;
  /** 当 status === "Success" 时填充。 */
  file_id?: string;
  base_resp: MinimaxBaseResp;
}

/** GET /v1/files/retrieve?file_id=... 的响应结构。 */
export interface MinimaxFileRetrieveResponse {
  file?: {
    file_id?: string;
    bytes?: number;
    /** 短时效的签名 CDN URL。 */
    download_url?: string;
    filename?: string;
  };
  base_resp: MinimaxBaseResp;
}

/** 当 MiniMax API 拒绝请求或返回非零 status_code 时抛出。 */
export class MinimaxApiError extends Error {
  readonly statusCode: number;
  readonly httpStatus: number;
  constructor(message: string, statusCode: number, httpStatus: number) {
    super(message);
    this.name = "MinimaxApiError";
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
  }
}
