/**
 * Memory Debug IPC Handlers
 *
 * Exposes the in-memory memory-debug event log to the renderer
 * for the Memory Debug Panel.
 */

import { ipcMain } from "electron";
import {
  clearMemoryEvents,
  getMemoryEvents,
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
};
