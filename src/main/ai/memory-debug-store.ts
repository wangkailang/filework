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
import type {
  MemoryEvent,
  MemoryEventDetail,
  MemoryEventType,
} from "../../shared/memory-types";

export type { MemoryEvent, MemoryEventDetail, MemoryEventType };

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
