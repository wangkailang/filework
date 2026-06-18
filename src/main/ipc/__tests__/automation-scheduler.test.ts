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

  it("manual trigger returns the queued run and executes it", async () => {
    const run = { id: "run-manual", automationId: "auto-1" };
    const runAutomationRun = vi.fn(async () => undefined);
    const scheduler = createAutomationScheduler({
      listDueAutomations: vi.fn(() => []),
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
});
