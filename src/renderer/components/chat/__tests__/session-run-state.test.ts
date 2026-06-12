import { describe, expect, it } from "vitest";
import {
  clearSessionRunState,
  clearSessionRunStateByTask,
  clearSessionUnreadState,
  getSessionRunState,
  markSessionPending,
  markSessionRunning,
  type SessionRunStateMap,
  settleSessionRunStateByTask,
} from "../session-run-state";

describe("session run state", () => {
  it("marks a session as pending before the task id is known", () => {
    const state = markSessionPending(
      {},
      {
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
      },
    );

    expect(getSessionRunState(state, "session-1")).toEqual({
      status: "pending",
      assistantMessageId: "assistant-1",
    });
  });

  it("marks a session as running for a task", () => {
    const pending = markSessionPending(
      {},
      {
        sessionId: "session-1",
        assistantMessageId: "assistant-pending",
      },
    );
    const state = markSessionRunning(pending, {
      sessionId: "session-1",
      taskId: "task-1",
      assistantMessageId: "assistant-1",
    });

    expect(getSessionRunState(state, "session-1")).toEqual({
      status: "running",
      taskId: "task-1",
      assistantMessageId: "assistant-1",
    });
  });

  it("clears the matching task without touching other running sessions", () => {
    const state: SessionRunStateMap = {
      "session-1": {
        status: "running",
        taskId: "task-1",
        assistantMessageId: "assistant-1",
      },
      "session-2": {
        status: "running",
        taskId: "task-2",
        assistantMessageId: "assistant-2",
      },
    };

    expect(clearSessionRunStateByTask(state, "task-1")).toEqual({
      "session-2": {
        status: "running",
        taskId: "task-2",
        assistantMessageId: "assistant-2",
      },
    });
  });

  it("clears a session even when it is still pending", () => {
    const state = markSessionPending(
      {},
      {
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
      },
    );

    expect(clearSessionRunState(state, "session-1")).toEqual({});
  });

  it("marks a background session as unread when its task settles", () => {
    const state: SessionRunStateMap = {
      "session-1": {
        status: "running",
        taskId: "task-1",
        assistantMessageId: "assistant-1",
      },
      "session-2": {
        status: "running",
        taskId: "task-2",
        assistantMessageId: "assistant-2",
      },
    };

    expect(settleSessionRunStateByTask(state, "task-1", "session-2")).toEqual({
      "session-1": {
        status: "unread",
        assistantMessageId: "assistant-1",
      },
      "session-2": {
        status: "running",
        taskId: "task-2",
        assistantMessageId: "assistant-2",
      },
    });
  });

  it("clears the active session state when its task settles", () => {
    const state: SessionRunStateMap = {
      "session-1": {
        status: "running",
        taskId: "task-1",
        assistantMessageId: "assistant-1",
      },
    };

    expect(settleSessionRunStateByTask(state, "task-1", "session-1")).toEqual(
      {},
    );
  });

  it("clears only unread state when a session is opened", () => {
    const state: SessionRunStateMap = {
      "session-1": {
        status: "unread",
        assistantMessageId: "assistant-1",
      },
      "session-2": {
        status: "running",
        taskId: "task-2",
        assistantMessageId: "assistant-2",
      },
    };

    expect(clearSessionUnreadState(state, "session-1")).toEqual({
      "session-2": {
        status: "running",
        taskId: "task-2",
        assistantMessageId: "assistant-2",
      },
    });
    expect(clearSessionUnreadState(state, "session-2")).toBe(state);
  });
});
