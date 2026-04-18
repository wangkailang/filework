import { ipcMain } from "electron";
import type { ChatMessage, ChatSession } from "../db";
import {
  createChatSession,
  deleteChatSession,
  forkChatSession,
  getChatHistory,
  getChatSessions,
  saveChatHistory,
  updateChatSession,
} from "../db";

export const registerChatHandlers = () => {
  // Sessions
  ipcMain.handle(
    "chat:createSession",
    async (
      _event,
      workspacePath: string,
      title?: string,
    ): Promise<ChatSession> => {
      return createChatSession(workspacePath, title);
    },
  );

  ipcMain.handle(
    "chat:getSessions",
    async (_event, workspacePath: string): Promise<ChatSession[]> => {
      return getChatSessions(workspacePath);
    },
  );

  ipcMain.handle(
    "chat:updateSession",
    async (
      _event,
      sessionId: string,
      updates: Partial<Pick<ChatSession, "title" | "updatedAt">>,
    ) => {
      updateChatSession(sessionId, updates);
      return true;
    },
  );

  ipcMain.handle("chat:deleteSession", async (_event, sessionId: string) => {
    deleteChatSession(sessionId);
    return true;
  });

  ipcMain.handle(
    "chat:forkSession",
    async (
      _event,
      sessionId: string,
      fromMessageId: string,
    ): Promise<ChatSession> => {
      return forkChatSession(sessionId, fromMessageId);
    },
  );

  // Messages (now session-scoped)
  ipcMain.handle("chat:getHistory", async (_event, sessionId: string) => {
    return getChatHistory(sessionId);
  });

  ipcMain.handle(
    "chat:saveHistory",
    async (
      _event,
      sessionId: string,
      workspacePath: string,
      messages: ChatMessage[],
    ) => {
      saveChatHistory(sessionId, workspacePath, messages);
      return true;
    },
  );
};
