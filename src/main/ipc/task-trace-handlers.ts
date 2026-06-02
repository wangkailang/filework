/**
 * 任务追踪 IPC 处理器
 *
 * 向渲染进程暴露持久化的任务追踪事件。
 *
 * 实时流式推送由 `emitTaskTraceEvent` 发出 `ai:task-trace-event` 处理。
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
