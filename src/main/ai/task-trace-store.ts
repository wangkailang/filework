/**
 * Task Trace Store
 *
 * Durable + streamable execution trace for tasks.
 *
 * - Durable: persisted to SQLite (see db.addTaskTraceEvent)
 * - Streamable: optionally emitted to renderer as events arrive
 *
 * This complements (not replaces) memory-debug-store which is in-memory only.
 */

import type { WebContents } from "electron";
import { addTaskTraceEvent, type TaskTraceEvent } from "../db";

export type TaskTraceEventInput = Omit<TaskTraceEvent, "id">;

export function emitTaskTraceEvent(
  sender: WebContents | null | undefined,
  event: TaskTraceEventInput,
): TaskTraceEvent {
  const persisted = addTaskTraceEvent(event);
  if (sender && !sender.isDestroyed()) {
    sender.send("ai:task-trace-event", {
      taskId: persisted.taskId,
      type: persisted.type,
      timestamp: persisted.timestamp,
      toolCallId: persisted.toolCallId ?? undefined,
      toolName: persisted.toolName ?? undefined,
      detail: persisted.detail,
    });
  }
  return persisted;
}
