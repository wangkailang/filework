/**
 * 内存调试存储(Memory Debug Store)
 *
 * 内存环形缓冲区,记录上下文压缩与 prompt 缓存事件,
 * 以便在渲染进程侧的调试面板中展示。
 *
 * 刻意不做持久化 —— 这是一个实时诊断工具。
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
// 常量
// ---------------------------------------------------------------------------

const MAX_EVENTS = 200;
const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// 存储
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

  // 环形缓冲区:满时丢弃最旧的事件
  while (events.length > MAX_EVENTS) {
    events.shift();
  }

  return event;
}

/**
 * 将一个内存事件写入存储,并通过 IPC 发送给渲染进程。
 * 整合了 addMemoryEvent + sender.send 的模式。
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
  return events.slice(start).reverse(); // 最新的在前
}

export function clearMemoryEvents(): void {
  events.length = 0;
}
