/**
 * Memory Debug Store
 *
 * In-memory ring buffer that records context-compression and prompt-cache
 * events so they can be surfaced in a debug panel on the renderer side.
 *
 * Deliberately NOT persisted — this is a live diagnostics tool.
 */

import crypto from "node:crypto";
import type { WebContents } from "electron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryEventType =
  | "compression-write"
  | "compression-skip"
  | "cache-write"
  | "cache-hit";

export interface MemoryEventDetail {
  /** Token count before compression */
  originalTokens?: number;
  /** Token count after compression */
  compressedTokens?: number;
  /** Number of messages that were compressed */
  messagesCompressed?: number;
  /** Compressed summary text (truncated to MAX_SUMMARY_LENGTH) */
  summary?: string;
  /** Anthropic cache creation input tokens */
  cacheWriteTokens?: number;
  /** Anthropic cache read input tokens */
  cacheReadTokens?: number;
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS = 200;
const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const events: MemoryEvent[] = [];

export function addMemoryEvent(
  taskId: string,
  type: MemoryEventType,
  detail: MemoryEventDetail,
  promptSnippet?: string,
): MemoryEvent {
  const event: MemoryEvent = {
    id: crypto.randomUUID(),
    taskId,
    promptSnippet: promptSnippet?.slice(0, 80),
    type,
    timestamp: new Date().toISOString(),
    detail: {
      ...detail,
      summary: detail.summary?.slice(0, MAX_SUMMARY_LENGTH),
    },
  };

  events.push(event);

  // Ring-buffer: drop oldest when full
  while (events.length > MAX_EVENTS) {
    events.shift();
  }

  return event;
}

/**
 * Write a memory event to the store AND send it to the renderer via IPC.
 * Consolidates the addMemoryEvent + sender.send pattern.
 */
export function emitMemoryEvent(
  sender: WebContents,
  taskId: string,
  type: MemoryEventType,
  detail: MemoryEventDetail,
  promptSnippet?: string,
): MemoryEvent {
  const event = addMemoryEvent(taskId, type, detail, promptSnippet);
  if (!sender.isDestroyed()) {
    sender.send("ai:memory-event", {
      taskId: event.taskId,
      type: event.type,
      promptSnippet: event.promptSnippet,
      detail: event.detail,
    });
  }
  return event;
}

export function getMemoryEvents(limit = 50): MemoryEvent[] {
  const start = Math.max(0, events.length - limit);
  return events.slice(start).reverse(); // newest first
}

export function clearMemoryEvents(): void {
  events.length = 0;
}
