/**
 * Shared types for MiniMax non-chat APIs (image / video generation).
 *
 * Chat goes through the OpenAI-compatible /v1/chat/completions endpoint
 * via the OpenAIAdapter — these types only cover the bespoke endpoints
 * (/v1/image_generation, /v1/video_generation, /v1/query/...).
 */

export interface MinimaxBaseResp {
  status_code: number;
  status_msg: string;
}

/** Response shape for POST /v1/image_generation. */
export interface MinimaxImageResponse {
  id?: string;
  data?: {
    image_urls?: string[];
  };
  metadata?: Record<string, unknown>;
  base_resp: MinimaxBaseResp;
}

// ─── Video generation ───────────────────────────────────────────────

/** Server-side state returned by /v1/query/video_generation. */
export type MinimaxVideoStatus =
  | "Queueing"
  | "Preparing"
  | "Processing"
  | "Success"
  | "Fail";

/** Response shape for POST /v1/video_generation. */
export interface MinimaxVideoSubmitResponse {
  task_id?: string;
  base_resp: MinimaxBaseResp;
}

/** Response shape for GET /v1/query/video_generation?task_id=... */
export interface MinimaxVideoQueryResponse {
  task_id?: string;
  status?: MinimaxVideoStatus;
  /** Populated when status === "Success". */
  file_id?: string;
  base_resp: MinimaxBaseResp;
}

/** Response shape for GET /v1/files/retrieve?file_id=... */
export interface MinimaxFileRetrieveResponse {
  file?: {
    file_id?: string;
    bytes?: number;
    /** Short-lived signed CDN URL. */
    download_url?: string;
    filename?: string;
  };
  base_resp: MinimaxBaseResp;
}

/** Thrown when the MiniMax API rejects a request or returns a non-zero status_code. */
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
