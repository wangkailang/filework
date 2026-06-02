/**
 * 记忆调试 IPC 处理器
 *
 * 将内存中的记忆调试事件日志暴露给渲染进程,
 * 供记忆调试面板使用。
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

  // 注入模拟事件以测试可视化图表(仅开发环境)
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
      // 回填时间戳,使时间线看起来更真实。
      // getMemoryEvents 返回的浅拷贝与 store 共享对象引用,
      // 因此此处的修改会就地更新规范事件本身。
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
