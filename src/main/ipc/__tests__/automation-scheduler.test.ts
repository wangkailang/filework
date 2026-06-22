import { describe, expect, it, vi } from "vitest";

import { createAutomationScheduler } from "../automation-scheduler";

const dueAutomation = {
  id: "auto-1",
  title: "Daily repo check",
  prompt: "Check repo",
  type: "project" as const,
  scheduleKind: "daily" as const,
  scheduleValue: "09:00",
  enabled: true,
  threadId: null,
  workspacePaths: ["/workspace"],
  runMode: "local" as const,
  modelId: null,
  reasoningEffort: null,
  lastRunAt: null,
  nextRunAt: "2026-06-18T09:00:00.000Z",
  createdAt: "2026-06-18T08:00:00.000Z",
  updatedAt: "2026-06-18T08:00:00.000Z",
};

describe("automation scheduler", () => {
  it("queues due automations and starts headless execution", async () => {
    const runAutomationRun = vi.fn(async () => undefined);
    const queueAutomationRun = vi.fn(() => ({
      id: "run-1",
      automationId: "auto-1",
    }));
    const scheduler = createAutomationScheduler({
      listDueAutomations: vi.fn(() => [dueAutomation]),
      listDueAutomationRunRetries: vi.fn(() => []),
      queueAutomationRun,
      runAutomationRun,
      now: () => new Date("2026-06-18T09:00:00.000Z"),
    });

    await scheduler.tick();

    expect(queueAutomationRun).toHaveBeenCalledWith("auto-1", {
      trigger: "scheduled",
      now: new Date("2026-06-18T09:00:00.000Z"),
    });
    expect(runAutomationRun).toHaveBeenCalledWith("run-1");
  });

  it("requeues due retry runs before normal scheduled automations", async () => {
    const now = new Date("2026-06-18T09:05:00.000Z");
    const retryRun = { id: "run-failed", automationId: "auto-1" };
    const runAutomationRun = vi.fn(async () => undefined);
    const listDueAutomationRunRetries = vi.fn(() => [retryRun]);
    const queueAutomationRunRetry = vi.fn(() => ({
      id: "run-retry",
      automationId: "auto-1",
    }));
    const queueAutomationRun = vi.fn(() => ({
      id: "run-scheduled",
      automationId: "auto-1",
    }));
    const scheduler = createAutomationScheduler({
      listDueAutomations: vi.fn(() => [dueAutomation]),
      listDueAutomationRunRetries,
      queueAutomationRun,
      queueAutomationRunRetry,
      runAutomationRun,
      now: () => now,
    });

    await scheduler.tick();

    expect(listDueAutomationRunRetries).toHaveBeenCalledWith(now);
    expect(queueAutomationRunRetry).toHaveBeenCalledWith("run-failed", {
      now,
    });
    expect(queueAutomationRun).not.toHaveBeenCalled();
    expect(runAutomationRun).toHaveBeenCalledWith("run-retry");
  });

  it("manual trigger returns the queued run and executes it", async () => {
    const run = { id: "run-manual", automationId: "auto-1" };
    const runAutomationRun = vi.fn(async () => undefined);
    const scheduler = createAutomationScheduler({
      listDueAutomations: vi.fn(() => []),
      listDueAutomationRunRetries: vi.fn(() => []),
      queueAutomationRun: vi.fn(() => run),
      runAutomationRun,
      now: () => new Date("2026-06-18T10:00:00.000Z"),
    });

    await expect(scheduler.triggerNow("auto-1")).resolves.toBe(run);
    expect(runAutomationRun).toHaveBeenCalledWith("run-manual");
  });

  it("recovers interrupted runs before the first startup tick", async () => {
    const runAutomationRun = vi.fn(async () => undefined);
    const recoverInterruptedRuns = vi.fn(() => []);
    const scheduler = createAutomationScheduler({
      listDueAutomations: vi.fn(() => []),
      listDueAutomationRunRetries: vi.fn(() => []),
      queueAutomationRun: vi.fn(),
      recoverInterruptedRuns,
      runAutomationRun,
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      intervalMs: 10_000,
    });

    scheduler.start();
    scheduler.stop();

    expect(recoverInterruptedRuns).toHaveBeenCalledWith(
      new Date("2026-06-18T10:00:00.000Z"),
    );
  });

  it("emits recovered interrupted runs for notification", async () => {
    const recoveredRun = {
      id: "run-recovered",
      automationId: "auto-1",
      automationTitle: "Daily repo check",
      trigger: "scheduled" as const,
      status: "failed" as const,
      triageStatus: "open" as const,
      needsActionReason: null,
      chatSessionId: null,
      assistantMessageId: null,
      taskId: null,
      prompt: "Check repo",
      workspacePaths: ["/workspace"],
      threadId: null,
      modelId: null,
      output: null,
      errorMessage: "Automation run interrupted before completion.",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      retryCount: 0,
      maxAttempts: 3,
      nextRetryAt: null,
      createdAt: "2026-06-18T09:00:00.000Z",
      updatedAt: "2026-06-18T10:00:00.000Z",
      startedAt: "2026-06-18T09:00:05.000Z",
      completedAt: "2026-06-18T10:00:00.000Z",
    };
    const onRecoveredRun = vi.fn();
    const scheduler = createAutomationScheduler({
      listDueAutomations: vi.fn(() => []),
      listDueAutomationRunRetries: vi.fn(() => []),
      queueAutomationRun: vi.fn(),
      recoverInterruptedRuns: vi.fn(() => [recoveredRun]),
      runAutomationRun: vi.fn(async () => undefined),
      now: () => new Date("2026-06-18T10:00:00.000Z"),
      intervalMs: 10_000,
      onRecoveredRun,
    });

    scheduler.start();
    scheduler.stop();

    expect(onRecoveredRun).toHaveBeenCalledWith(recoveredRun);
  });
});
