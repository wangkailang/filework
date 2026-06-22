import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
}));

const automationRuns = vi.hoisted(() => ({
  value: [] as Array<{
    id: string;
    automationId: string;
    automationTitle: string;
    chatSessionId: string | null;
  }>,
}));

vi.mock("../../db", () => ({
  listAutomationRuns: vi.fn(() => automationRuns.value),
}));

import { registerChatHandlers } from "../chat-handlers";

const session = (id: string, title: string) => ({
  id,
  workspacePath: "/workspace",
  title,
  createdAt: "2026-06-22T01:00:00.000Z",
  updatedAt: "2026-06-22T01:00:00.000Z",
});

describe("chat handlers", () => {
  beforeEach(() => {
    handlers.clear();
    automationRuns.value = [];
  });

  it("annotates chat sessions that belong to automation runs", async () => {
    automationRuns.value = [
      {
        id: "run-1",
        automationId: "auto-1",
        automationTitle: "每日 Filework commit 改动统计",
        chatSessionId: "session-automation",
      },
      {
        id: "run-ignored",
        automationId: "auto-ignored",
        automationTitle: "无会话运行",
        chatSessionId: null,
      },
    ];
    const store = {
      listSessions: vi.fn(async () => [
        session("session-automation", "新对话"),
        session("session-plain", "普通对话"),
      ]),
      createSession: vi.fn(),
      updateSession: vi.fn(),
      deleteSession: vi.fn(),
      forkSession: vi.fn(),
      getMessages: vi.fn(),
      saveMessages: vi.fn(),
    };

    registerChatHandlers(store as never);
    const getSessions = handlers.get("chat:getSessions");
    if (!getSessions) throw new Error("chat:getSessions missing");

    const result = (await getSessions(null, "/workspace")) as Array<{
      id: string;
      automationRun?: {
        id: string;
        automationId: string;
        title: string;
      };
    }>;

    expect(result[0]?.automationRun).toEqual({
      id: "run-1",
      automationId: "auto-1",
      title: "每日 Filework commit 改动统计",
    });
    expect(result[1]?.automationRun).toBeUndefined();
  });
});
