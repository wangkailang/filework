import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortControllers,
  activeTasks,
  activeToolExecutions,
  cleanupTask,
  drainTaskSteeringMessages,
  enqueueTaskSteering,
  getActiveTasks,
  getTaskEvents,
  manualStopFlags,
  pendingApprovals,
  recordTaskEvent,
  registerActiveTask,
  setRunEventLogForTesting,
  stopTaskExecution,
  toolCallToTaskMap,
} from "../ai-task-control";

describe("stopTaskExecution", () => {
  afterEach(() => {
    abortControllers.clear();
    activeTasks.clear();
    activeToolExecutions.clear();
    manualStopFlags.clear();
    pendingApprovals.clear();
    toolCallToTaskMap.clear();
  });

  it("aborts main/tool controllers and rejects pending approvals", () => {
    const taskId = "task-1";

    const mainController = new AbortController();
    abortControllers.set(taskId, mainController);

    const toolController = new AbortController();
    activeToolExecutions.set(taskId, new Set([toolController]));

    let approved: boolean | undefined;
    pendingApprovals.set("tool-call-1", (result) => {
      approved = result;
    });
    toolCallToTaskMap.set("tool-call-1", taskId);

    const stopped = stopTaskExecution(taskId);

    expect(stopped).toBe(true);
    expect(manualStopFlags.get(taskId)).toBe(true);
    expect(mainController.signal.aborted).toBe(true);
    expect(toolController.signal.aborted).toBe(true);
    expect(activeToolExecutions.get(taskId)?.size).toBe(0);
    expect(approved).toBe(false);
    expect(pendingApprovals.has("tool-call-1")).toBe(false);
    expect(toolCallToTaskMap.has("tool-call-1")).toBe(false);
  });

  it("still sets manual stop flag when controller does not exist", () => {
    const taskId = "task-2";
    const stopped = stopTaskExecution(taskId);

    expect(stopped).toBe(false);
    expect(manualStopFlags.get(taskId)).toBe(true);
  });

  it("continues when aborting a tool controller throws", () => {
    const taskId = "task-3";

    const fakeController = {
      abort: vi.fn(() => {
        throw new Error("boom");
      }),
    } as unknown as AbortController;

    activeToolExecutions.set(taskId, new Set([fakeController]));

    const stopped = stopTaskExecution(taskId);

    expect(stopped).toBe(false);
    expect(manualStopFlags.get(taskId)).toBe(true);
    expect(activeToolExecutions.get(taskId)?.size).toBe(0);
  });
});

describe("active task snapshots", () => {
  afterEach(() => {
    activeTasks.clear();
    setRunEventLogForTesting(null);
  });

  it("returns every active task without leaking WebContents", () => {
    const target = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;

    registerActiveTask({
      taskId: "task-a",
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      target,
    });
    registerActiveTask({
      taskId: "task-b",
      sessionId: "session-b",
      assistantMessageId: undefined,
      target,
    });

    expect(getActiveTasks()).toEqual([
      {
        taskId: "task-a",
        sessionId: "session-a",
        assistantMessageId: "assistant-a",
        streamEventCount: 0,
      },
      {
        taskId: "task-b",
        sessionId: "session-b",
        assistantMessageId: undefined,
        streamEventCount: 0,
      },
    ]);
  });

  it("records stream events with stable indexes and replays from a start index", () => {
    const target = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;

    registerActiveTask({
      taskId: "task-replay",
      sessionId: "session-replay",
      assistantMessageId: "assistant-replay",
      target,
    });

    recordTaskEvent("task-replay", "ai:stream-delta", { delta: "one" });
    recordTaskEvent("task-replay", "ai:stream-delta", { delta: "two" });
    recordTaskEvent("task-replay", "ai:stream-done", { id: "task-replay" });

    expect(getTaskEvents("task-replay", 1)).toEqual([
      {
        index: 1,
        channel: "ai:stream-delta",
        payload: { delta: "two" },
      },
      {
        index: 2,
        channel: "ai:stream-done",
        payload: { id: "task-replay" },
      },
    ]);
    expect(getActiveTasks()[0].streamEventCount).toBe(3);
  });

  it("persists stream events through an injected run event log", () => {
    const target = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;
    const log = {
      appendEvent: vi.fn(),
      deleteTask: vi.fn(),
      readEvents: vi.fn(() => [
        {
          kind: "event" as const,
          schemaVersion: 1 as const,
          taskId: "task-persisted",
          sessionId: "session-persisted",
          assistantMessageId: "assistant-persisted",
          index: 1,
          channel: "ai:stream-delta",
          payload: { delta: "from disk" },
          timestamp: "2026-06-24T01:00:01.000Z",
        },
      ]),
      getEventCount: vi.fn(() => 2),
      pruneOlderThan: vi.fn(() => 0),
    };

    setRunEventLogForTesting(log);
    registerActiveTask({
      taskId: "task-persisted",
      sessionId: "session-persisted",
      assistantMessageId: "assistant-persisted",
      target,
    });

    recordTaskEvent("task-persisted", "ai:stream-delta", {
      delta: "from memory",
    });

    expect(log.appendEvent).toHaveBeenCalledWith({
      taskId: "task-persisted",
      sessionId: "session-persisted",
      assistantMessageId: "assistant-persisted",
      index: 0,
      channel: "ai:stream-delta",
      payload: { delta: "from memory" },
      timestamp: expect.any(String),
    });
    expect(getTaskEvents("task-persisted", 1)).toEqual([
      {
        index: 1,
        channel: "ai:stream-delta",
        payload: { delta: "from disk" },
      },
    ]);
    expect(getActiveTasks()[0].streamEventCount).toBe(2);
  });

  it("continues persisting stream events after the in-memory replay cap", () => {
    const target = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;
    const appendEvent = vi.fn();
    const log = {
      appendEvent,
      deleteTask: vi.fn(),
      readEvents: vi.fn(() => []),
      getEventCount: vi.fn(() => appendEvent.mock.calls.length),
      pruneOlderThan: vi.fn(() => 0),
    };

    setRunEventLogForTesting(log);
    registerActiveTask({
      taskId: "task-long",
      sessionId: "session-long",
      assistantMessageId: "assistant-long",
      target,
    });

    for (let i = 0; i < 8001; i += 1) {
      recordTaskEvent("task-long", "ai:stream-delta", { delta: String(i) });
    }

    expect(appendEvent).toHaveBeenCalledTimes(8001);
    expect(appendEvent).toHaveBeenLastCalledWith({
      taskId: "task-long",
      sessionId: "session-long",
      assistantMessageId: "assistant-long",
      index: 8000,
      channel: "ai:stream-delta",
      payload: { delta: "8000" },
      timestamp: expect.any(String),
    });
    expect(getTaskEvents("task-long", 0)).toHaveLength(8000);
    expect(getActiveTasks()[0].streamEventCount).toBe(8001);
  });

  it("deletes persisted stream events when a task is cleaned up", () => {
    const target = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;
    const log = {
      appendEvent: vi.fn(),
      deleteTask: vi.fn(),
      readEvents: vi.fn(() => []),
      getEventCount: vi.fn(() => 0),
      pruneOlderThan: vi.fn(() => 0),
    };

    setRunEventLogForTesting(log);
    registerActiveTask({
      taskId: "task-cleanup",
      sessionId: "session-cleanup",
      assistantMessageId: "assistant-cleanup",
      target,
    });

    cleanupTask("task-cleanup");

    expect(log.deleteTask).toHaveBeenCalledWith("task-cleanup");
  });
});

describe("task steering queue", () => {
  afterEach(() => {
    cleanupTask("task-steer");
    cleanupTask("task-empty");
  });

  it("queues non-empty steering messages and drains them once", () => {
    expect(enqueueTaskSteering("task-steer", "  focus on tests  ")).toBe(true);
    expect(enqueueTaskSteering("task-steer", "\nthen stop\n")).toBe(true);
    expect(enqueueTaskSteering("task-empty", "   ")).toBe(false);

    expect(drainTaskSteeringMessages("task-steer")).toEqual([
      "focus on tests",
      "then stop",
    ]);
    expect(drainTaskSteeringMessages("task-steer")).toEqual([]);
  });

  it("clears queued steering when the task is cleaned up", () => {
    enqueueTaskSteering("task-steer", "do not continue");
    cleanupTask("task-steer");

    expect(drainTaskSteeringMessages("task-steer")).toEqual([]);
  });
});
