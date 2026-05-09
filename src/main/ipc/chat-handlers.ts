import { ipcMain } from "electron";

import type { JsonlSessionStore } from "../core/session/jsonl-store";
import type { ChatMessage, ChatSession } from "../core/session/types";

/**
 * Register chat-session IPC handlers backed by `JsonlSessionStore`.
 *
 * IPC contract is byte-equivalent to the pre-M3 SQLite path. The
 * underlying storage is now `~/.filework/sessions/<workspace-key>/<id>.jsonl`
 * managed by `core/session/jsonl-store.ts`.
 */
export const registerChatHandlers = (store: JsonlSessionStore) => {
  ipcMain.handle(
    "chat:createSession",
    async (
      _event,
      workspacePath: string,
      title?: string,
    ): Promise<ChatSession> => store.createSession(workspacePath, title),
  );

  ipcMain.handle(
    "chat:getSessions",
    async (_event, workspacePath: string): Promise<ChatSession[]> =>
      store.listSessions(workspacePath),
  );

  ipcMain.handle(
    "chat:updateSession",
    async (
      _event,
      sessionId: string,
      updates: Partial<Pick<ChatSession, "title" | "updatedAt">>,
    ) => {
      await store.updateSession(sessionId, updates);
      return true;
    },
  );

  ipcMain.handle("chat:deleteSession", async (_event, sessionId: string) => {
    await store.deleteSession(sessionId);
    return true;
  });

  ipcMain.handle(
    "chat:forkSession",
    async (
      _event,
      sessionId: string,
      fromMessageId: string,
    ): Promise<ChatSession> => store.forkSession(sessionId, fromMessageId),
  );

  ipcMain.handle("chat:getHistory", async (_event, sessionId: string) =>
    store.getMessages(sessionId),
  );

  ipcMain.handle(
    "chat:saveHistory",
    async (
      _event,
      sessionId: string,
      workspacePath: string,
      messages: ChatMessage[],
    ) => {
      await store.saveMessages(sessionId, workspacePath, messages);
      return true;
    },
  );
};
