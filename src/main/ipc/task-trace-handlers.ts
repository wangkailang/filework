/**
 * Task Trace IPC Handlers
 *
 * Exposes durable task trace events to the renderer.
 *
 * Live streaming is handled by `emitTaskTraceEvent` emitting `ai:task-trace-event`.
 */

import { ipcMain } from "electron";
import { getTaskSummary, getTaskTraceEvents } from "../db";

export const registerTaskTraceHandlers = () => {
  ipcMain.handle(
    "task-trace:getEvents",
    async (_event, payload: { taskId: string; limit?: number }) => {
      return getTaskTraceEvents(payload.taskId, payload.limit ?? 200);
    },
  );

  ipcMain.handle(
    "task-trace:getSummary",
    async (_event, payload: { taskId: string }) => {
      return getTaskSummary(payload.taskId);
    },
  );
};
