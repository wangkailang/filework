/**
 * Memory Debug IPC Handlers
 *
 * Exposes the in-memory memory-debug event log to the renderer
 * for the Memory Debug Panel.
 */

import { ipcMain } from "electron";
import {
  addMemoryEvent,
  clearMemoryEvents,
  getMemoryEvents,
  type MemoryEventType,
} from "../ai/memory-debug-store";

export const registerMemoryDebugHandlers = () => {
  ipcMain.handle(
    "memory-debug:getEvents",
    async (_event, payload: { limit?: number }) => {
      return getMemoryEvents(payload?.limit ?? 50);
    },
  );

  ipcMain.handle("memory-debug:clear", async () => {
    clearMemoryEvents();
    return { ok: true };
  });

  // Seed mock events for testing the visualization charts (dev only)
  if (!process.env.ELECTRON_RENDERER_URL) return;
  ipcMain.handle("memory-debug:seed", async () => {
    const types: {
      type: MemoryEventType;
      detail: () => Record<string, unknown>;
      snippet: string;
    }[] = [
      {
        type: "compression-write",
        detail: () => {
          const original = 8000 + Math.floor(Math.random() * 40000);
          const ratio = 0.2 + Math.random() * 0.5;
          const compressed = Math.floor(original * ratio);
          return {
            originalTokens: original,
            compressedTokens: compressed,
            messagesCompressed: 3 + Math.floor(Math.random() * 15),
            summaryTokens: compressed,
            summary: "用户讨论了文件整理方案，AI 提出按日期和类型分类的建议...",
          };
        },
        snippet: "帮我整理这个目录的文件",
      },
      {
        type: "compression-skip",
        detail: () => ({
          originalTokens: 1000 + Math.floor(Math.random() * 5000),
        }),
        snippet: "查找重复文件",
      },
      {
        type: "cache-write",
        detail: () => ({
          cacheWriteTokens: 2000 + Math.floor(Math.random() * 10000),
        }),
        snippet: "分析目录结构",
      },
      {
        type: "cache-hit",
        detail: () => ({
          cacheReadTokens: 2000 + Math.floor(Math.random() * 10000),
        }),
        snippet: "生成报告",
      },
    ];

    const count = 20 + Math.floor(Math.random() * 10);
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const pick = types[Math.floor(Math.random() * types.length)];
      addMemoryEvent(`seed-task-${i}`, pick.type, pick.detail(), pick.snippet);
      // Backdate timestamps so the timeline looks realistic.
      // getMemoryEvents returns shallow copies that share object references
      // with the store, so this mutation updates the canonical event in-place.
      const event = getMemoryEvents(1)[0];
      if (event) {
        event.timestamp = new Date(
          now - (count - i) * 60_000 * (1 + Math.random()),
        ).toISOString();
      }
    }

    return { ok: true, count };
  });
};
