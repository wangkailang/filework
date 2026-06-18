import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  created: [] as unknown[],
  updated: [] as unknown[],
  deleted: [] as string[],
  listedFilter: undefined as unknown,
}));

vi.mock("../../../../db", () => ({
  createAutomation: vi.fn((input: unknown) => {
    dbMock.created.push(input);
    return { id: "auto-1", ...(input as Record<string, unknown>) };
  }),
  updateAutomation: vi.fn((id: string, updates: unknown) => {
    dbMock.updated.push({ id, updates });
    return { id, ...(updates as Record<string, unknown>) };
  }),
  deleteAutomation: vi.fn((id: string) => {
    dbMock.deleted.push(id);
    return true;
  }),
  listAutomations: vi.fn((filter: unknown) => {
    dbMock.listedFilter = filter;
    return [{ id: "auto-1", title: "Daily check" }];
  }),
}));

import { buildAutomationUpdateTool } from "../automation";

describe("automation_update tool", () => {
  beforeEach(() => {
    dbMock.created = [];
    dbMock.updated = [];
    dbMock.deleted = [];
    dbMock.listedFilter = undefined;
  });

  it("creates a thread automation bound to the current session by default", async () => {
    const tool = buildAutomationUpdateTool({
      currentThreadId: "session-1",
      currentWorkspacePath: "/workspace",
    });

    const result = await tool.execute(
      {
        action: "create",
        automation: {
          title: "Deployment follow-up",
          prompt: "Check whether the deployment has finished.",
          type: "thread",
          scheduleKind: "interval",
          scheduleValue: "15m",
        },
      },
      {} as never,
    );

    expect(result).toMatchObject({
      action: "create",
      automation: { id: "auto-1", threadId: "session-1" },
    });
    expect(dbMock.created[0]).toMatchObject({
      type: "thread",
      threadId: "session-1",
      workspacePaths: null,
    });
  });

  it("defaults project automations to the current workspace path", async () => {
    const tool = buildAutomationUpdateTool({
      currentWorkspacePath: "/workspace",
    });

    await tool.execute(
      {
        action: "create",
        automation: {
          title: "Repo briefing",
          prompt: "Summarize the latest project changes.",
          type: "project",
          scheduleKind: "daily",
          scheduleValue: "09:00",
          runMode: "worktree",
        },
      },
      {} as never,
    );

    expect(dbMock.created[0]).toMatchObject({
      workspacePaths: ["/workspace"],
      runMode: "worktree",
    });
  });

  it("updates, deletes, and lists existing automation records", async () => {
    const tool = buildAutomationUpdateTool();

    await tool.execute(
      {
        action: "update",
        automation: {
          id: "auto-1",
          enabled: false,
          scheduleValue: "1h",
        },
      },
      {} as never,
    );
    await tool.execute(
      { action: "delete", automation: { id: "auto-1" } },
      {} as never,
    );
    const listed = await tool.execute(
      { action: "list", filter: { enabled: false, type: "thread" } },
      {} as never,
    );

    expect(dbMock.updated[0]).toEqual({
      id: "auto-1",
      updates: { enabled: false, scheduleValue: "1h" },
    });
    expect(dbMock.deleted).toEqual(["auto-1"]);
    expect(dbMock.listedFilter).toEqual({ enabled: false, type: "thread" });
    expect(listed).toMatchObject({ action: "list" });
  });
});
