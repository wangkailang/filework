/**
 * Storage shape for chat message parts.
 *
 * Hosted in `core/` so the JSONL session store, the future headless SDK,
 * and the renderer all read the same source of truth. Renderer modules
 * (chat/types.ts, ai-elements/confirmation.tsx, ai-elements/tool.tsx,
 * ai-elements/plan-viewer.tsx) re-export from here — no parallel
 * definitions to keep in sync.
 *
 * These are intentionally pure type definitions: no React, no DOM, no
 * Electron. The renderer's UI components live separately and consume
 * these shapes.
 */

// ─── Confirmation / Approval ────────────────────────────────────────

export type ApprovalState =
  | "approval-requested"
  | "approval-accepted"
  | "approval-rejected";

// ─── Tool execution state ───────────────────────────────────────────

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export interface ToolApproval {
  toolCallId: string;
  toolName: string;
  description: string;
  state: ApprovalState;
  /**
   * Optional contextual warning the renderer shows above the approval card.
   * Populated by `approval-hook.ts` for openPullRequest when the latest CI
   * run on the head branch is failing/cancelled (M8). Undefined for all
   * other tools and pre-M8 sessions.
   */
  extraContext?: string;
}

// ─── Plan viewer (data shape — UI lives in plan-viewer.tsx) ─────────

export interface PlanSubStepView {
  label: string;
  status: "pending" | "done";
}

export interface PlanStepArtifactView {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  success: boolean;
}

export interface PlanStepView {
  id: number;
  action: string;
  description: string;
  skillId?: string;
  verification?: string;
  subSteps?: PlanSubStepView[];
  artifacts?: PlanStepArtifactView[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  error?: string;
}

export interface PlanView {
  id: string;
  goal: string;
  steps: PlanStepView[];
  status:
    | "draft"
    | "approved"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
}

// ─── Recovery actions surfaced on errors ────────────────────────────

export type RecoveryAction = "retry" | "settings" | "new_chat";

// ─── MessagePart variants ───────────────────────────────────────────

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  state: ToolState;
  approval?: ToolApproval;
}

export interface PlanMessagePart {
  type: "plan";
  plan: PlanView;
}

export interface ErrorPart {
  type: "error";
  message: string;
  errorType?: string;
  recoveryActions?: RecoveryAction[];
}

export interface UsagePart {
  type: "usage";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelId: string | null;
  provider: string | null;
}

export interface ClarificationPart {
  type: "clarification";
  question: string;
  options?: string[];
}

/**
 * Inline generated image. Written by `media-handlers.ts` after a
 * MiniMax image_generation call succeeds; rendered via `MediaImageCard`
 * using the `local-file://` custom protocol.
 *
 * Persisted to the JSONL session store so the image survives reloads.
 * The file at `path` lives under `~/.filework/generated/{sessionId}/`.
 */
export interface ImagePart {
  type: "image";
  /** Absolute filesystem path to the saved image. */
  path: string;
  /** Original user prompt — shown under the image. */
  prompt: string;
  /** LLM config id that produced this — supports re-generate later. */
  configId: string;
  /** Short hex id from the generation call; useful as a React key. */
  imageId: string;
  /** Model identifier (e.g. "image-01"). Optional for back-compat. */
  modelId?: string;
}

/**
 * Image gallery surfaced by web tools. Emitted by the renderer side of
 * the stream subscription when `webSearch` (with `includeImages`) or
 * `webFetch` returns a non-empty `images` array — appended as a sibling
 * part right after the corresponding `tool` part so the user sees a
 * clickable thumbnail grid instead of a wall of image URLs.
 *
 * Distinct from `ImagePart` (single MiniMax-generated image saved to
 * disk under `~/.filework/generated/`): gallery images are *remote URLs*
 * with no local copy, and may load slowly / fail. The renderer must
 * tolerate `onError` per-image without breaking the card.
 */
export interface ImageGalleryPart {
  type: "image-gallery";
  /** Which tool produced the images — drives the card title. */
  source: "web-search" | "web-fetch" | "other";
  /** Query / URL that triggered the call, shown in the card header. */
  context?: string;
  images: Array<{
    /** Absolute http(s) image URL. */
    url: string;
    /** Optional click-through (page the image was found on). */
    sourceUrl?: string;
    /** Optional caption (Tavily description or img alt). */
    description?: string;
  }>;
}

/**
 * Embeddable videos surfaced by web tools. Counterpart to
 * `ImageGalleryPart`: when `webFetch` returns a non-empty `videos`
 * array (YouTube/Vimeo/Bilibili iframes, <video> elements, og:video),
 * the renderer appends one of these so the user gets thumbnail-and-play
 * cards instead of a wall of embed URLs.
 *
 * Click-to-load: thumbnails render first, the iframe / <video> only
 * mounts after the user clicks, keeping the page light and respecting
 * privacy for YouTube embeds.
 */
export interface VideoGalleryPart {
  type: "video-gallery";
  source: "web-fetch" | "other";
  /** URL / context that triggered the call (for the card header). */
  context?: string;
  videos: Array<{
    url: string;
    /** youtube / vimeo / bilibili / twitter / other / undefined for direct <video>. */
    provider?: string;
    /** Optional poster image (from <video poster=> or YouTube oEmbed-style hint). */
    poster?: string;
    /** Optional iframe title. */
    title?: string;
    /** Page the video was found on — click-through chip. */
    sourceUrl?: string;
  }>;
}

/**
 * Lightweight article-meta strip rendered above the gallery parts.
 * Composed from `webFetch` / `webFetchRendered` / `webScrape` results
 * when the page had at least one of byline / siteName / publishedTime.
 * Visual: favicon · siteName · • · byline · • · publishedTime.
 */
export interface ArticleMetaPart {
  type: "article-meta";
  /** Click-through URL for the whole chip. */
  pageUrl?: string;
  meta: {
    byline?: string;
    siteName?: string;
    publishedTime?: string;
    lang?: string;
    favicon?: string;
  };
}

/**
 * In-flight or completed video-generation job. Phase 3 — MiniMax videos
 * take 1–5 minutes, so the main process runs a watcher that updates this
 * part's `status` / `progressPct` / `resultPath` via the
 * `ai:media-job-update` IPC event.
 *
 * Persisted to JSONL like other parts, so a renderer reload still shows
 * the latest known state. The watcher writes to the DB even when the
 * renderer is gone; on next load the renderer re-subscribes by `jobId`.
 */
export interface VideoJobPart {
  type: "video-job";
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progressPct?: number | null;
  /** Absolute filesystem path once the video is downloaded. */
  resultPath?: string | null;
  errorMessage?: string | null;
  prompt: string;
  configId: string;
  modelId?: string;
}

/**
 * User-attached file (image / pdf / text). Created by `chat:attachFile`
 * after the renderer drops or picks a file: the source is copied into
 * `~/.filework/attachments/{sessionId}/{ts}-{shortId}.{ext}` so the
 * attachment survives across app restarts and JSONL stays small (path +
 * metadata only).
 *
 * Distinct from `ImagePart` (which is a *generated* image): this part
 * lives on user messages, drives composer-side chips, and the message
 * converter walks `parts` to build the user-message content array sent
 * to the LLM.
 *
 * `kind` is the coarse routing flag used by both renderer (icon vs.
 * thumbnail) and converter (image content / file content / inline text).
 */
export type AttachmentKind = "image" | "pdf" | "text";

export interface AttachmentPart {
  type: "attachment";
  /** Absolute path under `~/.filework/attachments/{sessionId}/`. */
  path: string;
  /** Original filename shown in the chip. */
  name: string;
  /** MIME sniffed from the extension at attach time. */
  mimeType: string;
  /** Bytes, captured at attach time. */
  size: number;
  /** Routing flag — image / pdf / text. */
  kind: AttachmentKind;
  /** 8-char hex paired with the timestamp; safe React key. */
  attachmentId: string;
}

export type MessagePart =
  | TextPart
  | ToolPart
  | PlanMessagePart
  | ErrorPart
  | UsagePart
  | ClarificationPart
  | ImagePart
  | ImageGalleryPart
  | VideoGalleryPart
  | ArticleMetaPart
  | VideoJobPart
  | AttachmentPart;
