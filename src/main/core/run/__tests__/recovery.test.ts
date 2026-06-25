import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlRunEventLog } from "../event-log";
import { recoverInterruptedRunEventLogs } from "../recovery";

describe("recoverInterruptedRunEventLogs", () => {
  let rootDir: string;
  let log: JsonlRunEventLog;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "fw-run-recovery-"));
    log = new JsonlRunEventLog(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("marks residual non-terminal run logs as interrupted failures", async () => {
    log.appendEvent({
      taskId: "task-interrupted",
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      index: 0,
      channel: "ai:stream-start",
      payload: { id: "task-interrupted" },
    });
    log.appendEvent({
      taskId: "task-interrupted",
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      index: 1,
      channel: "ai:stream-delta",
      payload: { id: "task-interrupted", delta: "partial output" },
    });
    const updateTask = vi.fn();
    const appendInterruptedMessage = vi.fn();
    const now = new Date("2026-06-25T01:00:00.000Z");

    const recovered = await recoverInterruptedRunEventLogs(log, {
      now,
      updateTask,
      appendInterruptedMessage,
    });

    expect(recovered).toEqual([
      {
        taskId: "task-interrupted",
        sessionId: "session-a",
        assistantMessageId: "assistant-a",
        terminal: false,
      },
    ]);
    expect(updateTask).toHaveBeenCalledWith("task-interrupted", {
      status: "failed",
      result:
        "Task interrupted because the application exited before the run completed. Please rerun the request if you still need it.",
      completedAt: "2026-06-25T01:00:00.000Z",
      updatedAt: "2026-06-25T01:00:00.000Z",
    });
    expect(appendInterruptedMessage).toHaveBeenCalledWith({
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      message:
        "Task interrupted because the application exited before the run completed. Please rerun the request if you still need it.",
      timestamp: "2026-06-25T01:00:00.000Z",
    });
    expect(log.readEvents("task-interrupted", 0)).toEqual([]);
  });

  it("cleans up residual terminal run logs without changing task status", async () => {
    log.appendEvent({
      taskId: "task-terminal",
      index: 0,
      channel: "ai:stream-start",
      payload: { id: "task-terminal" },
    });
    log.appendEvent({
      taskId: "task-terminal",
      index: 1,
      channel: "ai:stream-done",
      payload: { id: "task-terminal" },
    });
    const updateTask = vi.fn();
    const appendInterruptedMessage = vi.fn();

    const recovered = await recoverInterruptedRunEventLogs(log, {
      now: new Date("2026-06-25T01:00:00.000Z"),
      updateTask,
      appendInterruptedMessage,
    });

    expect(recovered).toEqual([
      {
        taskId: "task-terminal",
        sessionId: undefined,
        assistantMessageId: undefined,
        terminal: true,
      },
    ]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(appendInterruptedMessage).not.toHaveBeenCalled();
    expect(log.readEvents("task-terminal", 0)).toEqual([]);
  });
});
