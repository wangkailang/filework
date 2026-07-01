import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlRunEventLog } from "../event-log";
import { recoverInterruptedRunEventLogs } from "../recovery";

describe("recoverInterruptedRunEventLogs", () => {
  let rootDir: string;
  let log: JsonlRunEventLog;

  const appendSubagentTraceEvents = (
    taskId: string,
    options: { terminal?: boolean } = {},
  ) => {
    const route = {
      taskId,
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
    };
    log.appendEvent({
      ...route,
      index: 0,
      channel: "ai:stream-start",
      payload: { id: taskId },
    });
    log.appendEvent({
      ...route,
      index: 1,
      channel: "ai:subagent-spawn",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        toolCallId: "spawn-1",
        concurrency: 1,
        children: [{ childTaskId: "batch-1:0", goal: "Research A" }],
      },
    });
    log.appendEvent({
      ...route,
      index: 2,
      channel: "ai:subagent-delta",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        childTaskId: "batch-1:0",
        delta: "finding ",
      },
    });
    log.appendEvent({
      ...route,
      index: 3,
      channel: "ai:subagent-delta",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        childTaskId: "batch-1:0",
        delta: "one",
      },
    });
    log.appendEvent({
      ...route,
      index: 4,
      channel: "ai:subagent-tool-call",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        childTaskId: "batch-1:0",
        toolCallId: "tool-1",
        toolName: "readFile",
        args: { path: "/ws/a.md" },
      },
    });
    log.appendEvent({
      ...route,
      index: 5,
      channel: "ai:subagent-tool-result",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        childTaskId: "batch-1:0",
        toolCallId: "tool-1",
        result: { success: true, content: "ok" },
      },
    });
    log.appendEvent({
      ...route,
      index: 6,
      channel: "ai:subagent-child-usage",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        childTaskId: "batch-1:0",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });
    log.appendEvent({
      ...route,
      index: 7,
      channel: "ai:subagent-report",
      payload: {
        parentTaskId: taskId,
        batchId: "batch-1",
        childTaskId: "batch-1:0",
        report: {
          agentId: "batch-1:0",
          status: "failed",
          summary: "partial summary",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCallCount: 1,
          durationMs: 1234,
          error: "boom",
        },
      },
    });
    if (options.terminal) {
      log.appendEvent({
        ...route,
        index: 8,
        channel: "ai:stream-done",
        payload: { id: taskId },
      });
    }
  };

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

  it("materializes residual subagent trace before marking an interrupted run failed", async () => {
    appendSubagentTraceEvents("task-subagent");
    const updateTask = vi.fn();
    const appendInterruptedMessage = vi.fn();
    const appendRecoveredMessageParts = vi.fn();

    await recoverInterruptedRunEventLogs(log, {
      now: new Date("2026-06-25T01:00:00.000Z"),
      updateTask,
      appendInterruptedMessage,
      appendRecoveredMessageParts,
    });

    expect(appendRecoveredMessageParts).toHaveBeenCalledWith({
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      timestamp: "2026-06-25T01:00:00.000Z",
      parts: [
        {
          type: "subagent",
          batchId: "batch-1",
          toolCallId: "spawn-1",
          concurrency: 1,
          children: [
            {
              childTaskId: "batch-1:0",
              goal: "Research A",
              status: "failed",
              stepCount: 1,
              toolCalls: [
                {
                  toolCallId: "tool-1",
                  toolName: "readFile",
                  state: "output-available",
                },
              ],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              summary: "partial summary",
              error: "boom",
              durationMs: 1234,
              parts: [
                { type: "text", text: "finding one" },
                {
                  type: "tool",
                  toolCallId: "tool-1",
                  toolName: "readFile",
                  args: { path: "/ws/a.md" },
                  result: { success: true, content: "ok" },
                  state: "output-available",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(appendInterruptedMessage).toHaveBeenCalledWith({
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      message:
        "Task interrupted because the application exited before the run completed. Please rerun the request if you still need it.",
      timestamp: "2026-06-25T01:00:00.000Z",
    });
    expect(log.readEvents("task-subagent", 0)).toEqual([]);
  });

  it("materializes subagent trace for residual terminal logs without marking interruption", async () => {
    appendSubagentTraceEvents("task-terminal-subagent", { terminal: true });
    const updateTask = vi.fn();
    const appendInterruptedMessage = vi.fn();
    const appendRecoveredMessageParts = vi.fn();

    const recovered = await recoverInterruptedRunEventLogs(log, {
      now: new Date("2026-06-25T01:00:00.000Z"),
      updateTask,
      appendInterruptedMessage,
      appendRecoveredMessageParts,
    });

    expect(recovered).toEqual([
      {
        taskId: "task-terminal-subagent",
        sessionId: "session-a",
        assistantMessageId: "assistant-a",
        terminal: true,
      },
    ]);
    expect(appendRecoveredMessageParts).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
    expect(appendInterruptedMessage).not.toHaveBeenCalled();
    expect(log.readEvents("task-terminal-subagent", 0)).toEqual([]);
  });
});
