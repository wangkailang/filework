import { ipcMain } from "electron";

import type { JsonlSessionStore } from "../core/session/jsonl-store";
import type { ChatMessage, ChatSession } from "../core/session/types";
import { listAutomationRuns } from "../db";

type SessionMetadataOptions = {
  lastActiveBranch?: string | null;
};

const withAutomationRunMetadata = (sessions: ChatSession[]): ChatSession[] => {
  const runsBySessionId = new Map<
    string,
    NonNullable<ChatSession["automationRun"]>
  >();

  for (const run of listAutomationRuns()) {
    if (!run.chatSessionId || runsBySessionId.has(run.chatSessionId)) {
      continue;
    }
    runsBySessionId.set(run.chatSessionId, {
      id: run.id,
      automationId: run.automationId,
      title: run.automationTitle,
    });
  }

  return sessions.map((session) => {
    const automationRun = runsBySessionId.get(session.id);
    return automationRun ? { ...session, automationRun } : session;
  });
};

/**
 * 注册由 `JsonlSessionStore` 支撑的聊天会话 IPC handler。
 *
 * IPC 契约与 M3 之前的 SQLite 路径逐字节等价。底层存储现为
 * `~/.filework/sessions/<workspace-key>/<id>.jsonl`,由
 * `core/session/jsonl-store.ts` 管理。
 */
export const registerChatHandlers = (store: JsonlSessionStore) => {
  ipcMain.handle(
    "chat:createSession",
    async (
      _event,
      workspacePath: string,
      title?: string,
      options?: SessionMetadataOptions,
    ): Promise<ChatSession> =>
      store.createSession(workspacePath, title, options),
  );

  ipcMain.handle(
    "chat:getSessions",
    async (_event, workspacePath: string): Promise<ChatSession[]> =>
      withAutomationRunMetadata(await store.listSessions(workspacePath)),
  );

  ipcMain.handle(
    "chat:updateSession",
    async (
      _event,
      sessionId: string,
      updates: Partial<
        Pick<ChatSession, "lastActiveBranch" | "title" | "updatedAt">
      >,
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
      options?: SessionMetadataOptions,
    ) => {
      await store.saveMessages(sessionId, workspacePath, messages, options);
      return true;
    },
  );
};
