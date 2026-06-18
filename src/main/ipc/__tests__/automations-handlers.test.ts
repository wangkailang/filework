import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, payload: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
}));

const dbState = {
  automations: [] as Array<{
    id: string;
    title: string;
    prompt: string;
    type: "thread" | "standalone" | "project";
    scheduleKind: "interval" | "daily" | "weekly" | "cron";
    scheduleValue: string;
    enabled: boolean;
    threadId: string | null;
    workspacePaths: string[] | null;
    runMode: "local" | "worktree" | null;
    modelId: string | null;
    reasoningEffort: string | null;
    lastRunAt: string | null;
    nextRunAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>,
};

vi.mock("../../db", () => ({
  createAutomation: vi.fn((input) => {
    const now = new Date("2026-06-18T01:00:00.000Z").toISOString();
    const row = {
      id: `auto-${dbState.automations.length + 1}`,
      enabled: true,
      threadId: null,
      workspacePaths: null,
      runMode: null,
      modelId: null,
      reasoningEffort: null,
      lastRunAt: null,
      nextRunAt: "2026-06-18T02:00:00.000Z",
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    dbState.automations.push(row);
    return row;
  }),
  deleteAutomation: vi.fn((id: string) => {
    const before = dbState.automations.length;
    dbState.automations = dbState.automations.filter((a) => a.id !== id);
    return dbState.automations.length !== before;
  }),
  listAutomations: vi.fn(() => dbState.automations),
  triggerAutomation: vi.fn((id: string) => {
    const row = dbState.automations.find((a) => a.id === id);
    if (!row) throw new Error(`Automation not found: ${id}`);
    row.lastRunAt = "2026-06-18T03:00:00.000Z";
    row.nextRunAt = "2026-06-18T04:00:00.000Z";
    return row;
  }),
  updateAutomation: vi.fn((id, updates) => {
    const row = dbState.automations.find((a) => a.id === id);
    if (!row) throw new Error(`Automation not found: ${id}`);
    Object.assign(row, updates, {
      updatedAt: new Date("2026-06-18T02:00:00.000Z").toISOString(),
    });
    return row;
  }),
}));

import { registerAutomationsHandlers } from "../automations-handlers";

describe("automations handlers", () => {
  beforeEach(() => {
    handlers.clear();
    dbState.automations.length = 0;
    registerAutomationsHandlers();
  });

  it("registers list/create/update/delete automation IPC handlers", () => {
    expect(handlers.has("automations:list")).toBe(true);
    expect(handlers.has("automations:create")).toBe(true);
    expect(handlers.has("automations:update")).toBe(true);
    expect(handlers.has("automations:trigger")).toBe(true);
    expect(handlers.has("automations:delete")).toBe(true);
  });

  it("creates and lists persisted automation definitions", async () => {
    const create = handlers.get("automations:create");
    const list = handlers.get("automations:list");
    if (!create || !list) throw new Error("automation handlers missing");

    const created = await create(null, {
      title: "Daily repo check",
      prompt: "Check CI and summarize failures.",
      type: "project",
      scheduleKind: "daily",
      scheduleValue: "09:00",
      workspacePaths: ["/workspace"],
      runMode: "worktree",
    });

    expect(created).toMatchObject({
      id: "auto-1",
      title: "Daily repo check",
      type: "project",
      workspacePaths: ["/workspace"],
      runMode: "worktree",
    });
    await expect(list(null, undefined)).resolves.toHaveLength(1);
  });

  it("updates enabled state and deletes automation definitions", async () => {
    const create = handlers.get("automations:create");
    const update = handlers.get("automations:update");
    const del = handlers.get("automations:delete");
    if (!create || !update || !del)
      throw new Error("automation handlers missing");

    const created = (await create(null, {
      title: "Thread heartbeat",
      prompt: "Continue if new evidence is available.",
      type: "thread",
      scheduleKind: "interval",
      scheduleValue: "1h",
    })) as { id: string };

    await expect(
      update(null, { id: created.id, updates: { enabled: false } }),
    ).resolves.toMatchObject({ enabled: false });
    await expect(del(null, { id: created.id })).resolves.toBe(true);
    expect(dbState.automations).toHaveLength(0);
  });

  it("marks an automation as manually triggered", async () => {
    const create = handlers.get("automations:create");
    const trigger = handlers.get("automations:trigger");
    if (!create || !trigger) throw new Error("automation handlers missing");

    const created = (await create(null, {
      title: "Manual check",
      prompt: "Check the release notes.",
      type: "standalone",
      scheduleKind: "interval",
      scheduleValue: "1h",
    })) as { id: string };

    await expect(trigger(null, { id: created.id })).resolves.toMatchObject({
      id: created.id,
      lastRunAt: "2026-06-18T03:00:00.000Z",
      nextRunAt: "2026-06-18T04:00:00.000Z",
    });
  });
});
