/**
 * Shared types for the memory debug system.
 *
 * Used by both main process (memory-debug-store) and renderer (charts/panels).
 */

export type MemoryEventType =
  | "compression-write"
  | "compression-skip"
  | "compression-error"
  | "result-summarize"
  | "truncation-drop"
  | "cache-write"
  | "cache-hit";

export interface MemoryEventDetail {
  /** Token count before compression */
  originalTokens?: number;
  /** Token count after compression */
  compressedTokens?: number;
  /** Number of messages that were compressed */
  messagesCompressed?: number;
  /** Token count of the generated summary message */
  summaryTokens?: number;
  /** Compressed summary text (truncated to MAX_SUMMARY_LENGTH) */
  summary?: string;
  /** Anthropic cache creation input tokens */
  cacheWriteTokens?: number;
  /** Anthropic cache read input tokens */
  cacheReadTokens?: number;
  /** Number of messages dropped by simple truncation */
  messagesDropped?: number;
  /** Number of tool results summarized */
  resultsSummarized?: number;
  /** Error message for failed operations */
  error?: string;
}

export interface MemoryEvent {
  id: string;
  taskId: string;
  /** First ~80 chars of the user prompt that triggered this task */
  promptSnippet?: string;
  type: MemoryEventType;
  timestamp: string;
  detail: MemoryEventDetail;
}
