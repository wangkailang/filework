/**
 * 任务执行轨迹存储(Task Trace Store)
 *
 * 任务的持久化 + 可流式输出的执行轨迹。
 *
 * - 持久化:落盘到 SQLite(见 db.addTaskTraceEvent)
 * - 可流式输出:事件到达时可选地发送给渲染进程
 *
 * 它是对仅存于内存的 memory-debug-store 的补充(而非替代)。
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
