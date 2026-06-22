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
  runs: [] as Array<{
    id: string;
    automationId: string;
    automationTitle: string;
    trigger: "manual" | "scheduled";
    status:
      | "queued"
      | "running"
      | "needs_action"
      | "succeeded"
      | "failed"
      | "canceled";
    triageStatus: "open" | "handled";
    needsActionReason: string | null;
    chatSessionId: string | null;
    assistantMessageId: string | null;
    taskId: string | null;
    prompt: string;
    workspacePaths: string[] | null;
    threadId: string | null;
    modelId: string | null;
    output: string | null;
    errorMessage: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
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
  listAutomationRuns: vi.fn((filter) => {
    let rows = dbState.runs;
    if (filter?.triageStatus) {
      rows = rows.filter((run) => run.triageStatus === filter.triageStatus);
    }
    return rows;
  }),
  markAutomationRunHandled: vi.fn((id: string) => {
    const run = dbState.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Automation run not found: ${id}`);
    run.triageStatus = "handled";
    run.updatedAt = "2026-06-18T04:00:00.000Z";
    return run;
  }),
  cancelAutomationRun: vi.fn((id: string) => {
    const run = dbState.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Automation run not found: ${id}`);
    run.status = "canceled";
    run.triageStatus = "handled";
    run.updatedAt = "2026-06-18T04:00:00.000Z";
    run.completedAt = "2026-06-18T04:00:00.000Z";
    return run;
  }),
  cleanupAutomationRuns: vi.fn(() => {
    const before = dbState.runs.length;
    dbState.runs = dbState.runs.filter((run) => run.triageStatus !== "handled");
    return { deleted: before - dbState.runs.length };
  }),
  listAutomationRunEvents: vi.fn((runId: string) => [
    {
      id: "event-1",
      runId,
      sequence: 1,
      type: "message_update",
      message: "Repo is clean.",
      toolName: null,
      detail: null,
      createdAt: "2026-06-18T04:00:01.000Z",
    },
  ]),
  updateAutomation: vi.fn((id, updates) => {
    const row = dbState.automations.find((a) => a.id === id);
    if (!row) throw new Error(`Automation not found: ${id}`);
    Object.assign(row, updates, {
      updatedAt: new Date("2026-06-18T02:00:00.000Z").toISOString(),
    });
    return row;
  }),
}));

vi.mock("../automation-service", () => ({
  prepareAutomationChatRun: vi.fn(
    (id: string, input: { assistantMessageId: string; sessionId: string }) => {
      const automation = dbState.automations.find((a) => a.id === id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      const run = {
        id: `run-${dbState.runs.length + 1}`,
        automationId: id,
        automationTitle: automation.title,
        trigger: "manual" as const,
        status: "queued" as const,
        triageStatus: "open" as const,
        needsActionReason: null,
        chatSessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        taskId: null,
        prompt: automation.prompt,
        workspacePaths: automation.workspacePaths,
        threadId: automation.threadId,
        modelId: automation.modelId,
        output: null,
        errorMessage: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        createdAt: "2026-06-18T03:00:00.000Z",
        updatedAt: "2026-06-18T03:00:00.000Z",
        startedAt: null,
        completedAt: null,
      };
      dbState.runs.push(run);
      return run;
    },
  ),
  triggerAutomationNow: vi.fn((id: string) => {
    const automation = dbState.automations.find((a) => a.id === id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    const run = {
      id: `run-${dbState.runs.length + 1}`,
      automationId: id,
      automationTitle: automation.title,
      trigger: "manual" as const,
      status: "queued" as const,
      triageStatus: "open" as const,
      needsActionReason: null,
      chatSessionId: null,
      assistantMessageId: null,
      taskId: null,
      prompt: automation.prompt,
      workspacePaths: automation.workspacePaths,
      threadId: automation.threadId,
      modelId: automation.modelId,
      output: null,
      errorMessage: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      createdAt: "2026-06-18T03:00:00.000Z",
      updatedAt: "2026-06-18T03:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
    dbState.runs.push(run);
    return run;
  }),
  rerunAutomationRun: vi.fn((runId: string) => {
    const existing = dbState.runs.find((run) => run.id === runId);
    if (!existing) throw new Error(`Automation run not found: ${runId}`);
    const run = {
      ...existing,
      id: `run-${dbState.runs.length + 1}`,
      trigger: "manual" as const,
      status: "queued" as const,
      triageStatus: "open" as const,
      needsActionReason: null,
      chatSessionId: existing.chatSessionId,
      assistantMessageId: existing.assistantMessageId,
      taskId: null,
      output: null,
      errorMessage: null,
      createdAt: "2026-06-18T04:00:00.000Z",
      updatedAt: "2026-06-18T04:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
    dbState.runs.push(run);
    return run;
  }),
  continueAutomationRun: vi.fn((runId: string) => {
    const existing = dbState.runs.find((run) => run.id === runId);
    if (!existing) throw new Error(`Automation run not found: ${runId}`);
    existing.status = "queued";
    existing.triageStatus = "open";
    existing.needsActionReason = null;
    existing.errorMessage = null;
    existing.completedAt = null;
    existing.updatedAt = "2026-06-18T04:05:00.000Z";
    return existing;
  }),
}));

import { cleanupAutomationRuns } from "../../db";
import { registerAutomationsHandlers } from "../automations-handlers";

describe("automations handlers", () => {
  beforeEach(() => {
    handlers.clear();
    dbState.automations.length = 0;
    dbState.runs.length = 0;
    registerAutomationsHandlers();
  });

  it("registers list/create/update/delete automation IPC handlers", () => {
    expect(handlers.has("automations:list")).toBe(true);
    expect(handlers.has("automations:create")).toBe(true);
    expect(handlers.has("automations:update")).toBe(true);
    expect(handlers.has("automations:trigger")).toBe(true);
    expect(handlers.has("automations:prepareChatRun")).toBe(true);
    expect(handlers.has("automations:listRuns")).toBe(true);
    expect(handlers.has("automations:markRunHandled")).toBe(true);
    expect(handlers.has("automations:cancelRun")).toBe(true);
    expect(handlers.has("automations:continueRun")).toBe(true);
    expect(handlers.has("automations:rerun")).toBe(true);
    expect(handlers.has("automations:listRunEvents")).toBe(true);
    expect(handlers.has("automations:cleanupRuns")).toBe(true);
    expect(handlers.has("automations:previewSchedule")).toBe(true);
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

  it("normalizes workspace paths when creating automation definitions", async () => {
    const create = handlers.get("automations:create");
    if (!create) throw new Error("automation create handler missing");

    await expect(
      create(null, {
        title: "  Daily repo check  ",
        prompt: "  Check CI and summarize failures.  ",
        type: "project",
        scheduleKind: "daily",
        scheduleValue: "  09:00  ",
        workspacePaths: ["  /workspace  ", "", "   "],
        runMode: "worktree",
      }),
    ).resolves.toMatchObject({
      title: "Daily repo check",
      prompt: "Check CI and summarize failures.",
      scheduleValue: "09:00",
      workspacePaths: ["/workspace"],
    });
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

  it("queues an automation run when manually triggered", async () => {
    const create = handlers.get("automations:create");
    const trigger = handlers.get("automations:trigger");
    const listRuns = handlers.get("automations:listRuns");
    if (!create || !trigger || !listRuns)
      throw new Error("automation handlers missing");

    const created = (await create(null, {
      title: "Manual check",
      prompt: "Check the release notes.",
      type: "standalone",
      scheduleKind: "interval",
      scheduleValue: "1h",
    })) as { id: string };

    await expect(trigger(null, { id: created.id })).resolves.toMatchObject({
      automationId: created.id,
      trigger: "manual",
      status: "queued",
    });
    await expect(listRuns(null, { automationId: created.id })).resolves.toEqual(
      [
        expect.objectContaining({
          automationId: created.id,
          status: "queued",
        }),
      ],
    );
  });

  it("prepares a chat-backed automation run without launching headless execution", async () => {
    const create = handlers.get("automations:create");
    const prepareChatRun = handlers.get("automations:prepareChatRun");
    if (!create || !prepareChatRun)
      throw new Error("automation handlers missing");

    const created = (await create(null, {
      title: "Manual chat check",
      prompt: "Check the release notes.",
      type: "standalone",
      scheduleKind: "interval",
      scheduleValue: "1h",
    })) as { id: string };

    await expect(
      prepareChatRun(null, {
        assistantMessageId: "assistant-1",
        id: created.id,
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      automationId: created.id,
      assistantMessageId: "assistant-1",
      chatSessionId: "session-1",
      status: "queued",
      taskId: null,
      trigger: "manual",
    });
  });

  it("lists recent automation runs for triage", async () => {
    dbState.runs.push({
      id: "run-1",
      automationId: "auto-1",
      automationTitle: "Daily repo check",
      trigger: "scheduled",
      status: "failed",
      triageStatus: "open",
      needsActionReason: null,
      chatSessionId: null,
      assistantMessageId: null,
      taskId: null,
      prompt: "Check repo",
      workspacePaths: ["/workspace"],
      threadId: null,
      modelId: null,
      output: null,
      errorMessage: "Command failed",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      createdAt: "2026-06-18T03:00:00.000Z",
      updatedAt: "2026-06-18T03:01:00.000Z",
      startedAt: "2026-06-18T03:00:05.000Z",
      completedAt: "2026-06-18T03:01:00.000Z",
    });

    const listRuns = handlers.get("automations:listRuns");
    if (!listRuns) throw new Error("automation runs handler missing");

    await expect(listRuns(null, { limit: 10 })).resolves.toMatchObject([
      {
        id: "run-1",
        automationTitle: "Daily repo check",
        status: "failed",
        triageStatus: "open",
        errorMessage: "Command failed",
      },
    ]);
  });

  it("supports triage actions for handled, canceled, and rerun runs", async () => {
    dbState.runs.push({
      id: "run-1",
      automationId: "auto-1",
      automationTitle: "Daily repo check",
      trigger: "scheduled",
      status: "needs_action",
      triageStatus: "open",
      needsActionReason: "Requires approval",
      chatSessionId: null,
      assistantMessageId: null,
      taskId: null,
      prompt: "Check repo",
      workspacePaths: ["/workspace"],
      threadId: null,
      modelId: null,
      output: "Approval required",
      errorMessage: "Requires approval",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      createdAt: "2026-06-18T03:00:00.000Z",
      updatedAt: "2026-06-18T03:01:00.000Z",
      startedAt: "2026-06-18T03:00:05.000Z",
      completedAt: null,
    });

    const markHandled = handlers.get("automations:markRunHandled");
    const cancelRun = handlers.get("automations:cancelRun");
    const continueRun = handlers.get("automations:continueRun");
    const rerun = handlers.get("automations:rerun");
    const listRunEvents = handlers.get("automations:listRunEvents");
    const listRuns = handlers.get("automations:listRuns");
    if (
      !markHandled ||
      !cancelRun ||
      !continueRun ||
      !rerun ||
      !listRunEvents ||
      !listRuns
    ) {
      throw new Error("automation run action handlers missing");
    }

    await expect(markHandled(null, { id: "run-1" })).resolves.toMatchObject({
      id: "run-1",
      triageStatus: "handled",
    });
    dbState.runs[0].triageStatus = "open";
    await expect(cancelRun(null, { id: "run-1" })).resolves.toMatchObject({
      id: "run-1",
      status: "canceled",
      triageStatus: "handled",
    });
    dbState.runs[0].status = "needs_action";
    dbState.runs[0].triageStatus = "open";
    dbState.runs[0].needsActionReason = "Requires approval";
    dbState.runs[0].errorMessage = "Requires approval";
    await expect(continueRun(null, { id: "run-1" })).resolves.toMatchObject({
      id: "run-1",
      status: "queued",
      triageStatus: "open",
      needsActionReason: null,
    });
    await expect(rerun(null, { id: "run-1" })).resolves.toMatchObject({
      id: "run-2",
      trigger: "manual",
      status: "queued",
    });
    await expect(listRunEvents(null, { id: "run-1" })).resolves.toEqual([
      expect.objectContaining({
        runId: "run-1",
        sequence: 1,
        type: "message_update",
      }),
    ]);
    await expect(
      listRuns(null, { triageStatus: "open", limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "run-1", triageStatus: "open" }),
      expect.objectContaining({ id: "run-2", triageStatus: "open" }),
    ]);
  });

  it("cleans handled automation run history", async () => {
    dbState.runs.push(
      {
        id: "run-open",
        automationId: "auto-1",
        automationTitle: "Daily repo check",
        trigger: "scheduled",
        status: "failed",
        triageStatus: "open",
        needsActionReason: null,
        chatSessionId: null,
        assistantMessageId: null,
        taskId: null,
        prompt: "Check repo",
        workspacePaths: ["/workspace"],
        threadId: null,
        modelId: null,
        output: null,
        errorMessage: "Command failed",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        createdAt: "2026-06-18T03:00:00.000Z",
        updatedAt: "2026-06-18T03:01:00.000Z",
        startedAt: "2026-06-18T03:00:05.000Z",
        completedAt: "2026-06-18T03:01:00.000Z",
      },
      {
        id: "run-handled",
        automationId: "auto-1",
        automationTitle: "Daily repo check",
        trigger: "scheduled",
        status: "succeeded",
        triageStatus: "handled",
        needsActionReason: null,
        chatSessionId: null,
        assistantMessageId: null,
        taskId: null,
        prompt: "Check repo",
        workspacePaths: ["/workspace"],
        threadId: null,
        modelId: null,
        output: "OK",
        errorMessage: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        createdAt: "2026-06-17T03:00:00.000Z",
        updatedAt: "2026-06-17T03:01:00.000Z",
        startedAt: "2026-06-17T03:00:05.000Z",
        completedAt: "2026-06-17T03:01:00.000Z",
      },
    );

    const cleanupRuns = handlers.get("automations:cleanupRuns");
    const listRuns = handlers.get("automations:listRuns");
    if (!cleanupRuns || !listRuns)
      throw new Error("automation cleanup handler missing");

    await expect(
      cleanupRuns(null, { triageStatus: "handled" }),
    ).resolves.toEqual({ deleted: 1 });
    await expect(listRuns(null, { limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: "run-open" }),
    ]);
  });

  it("forwards run history retention filters when cleaning handled runs", async () => {
    const cleanupRuns = handlers.get("automations:cleanupRuns");
    if (!cleanupRuns) throw new Error("automation cleanup handler missing");

    await cleanupRuns(null, {
      olderThanDays: 30,
      triageStatus: "handled",
    });

    expect(cleanupAutomationRuns).toHaveBeenLastCalledWith({
      olderThanDays: 30,
      triageStatus: "handled",
    });
  });
});
