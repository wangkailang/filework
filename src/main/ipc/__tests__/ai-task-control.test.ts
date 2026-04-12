import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortControllers,
  activeToolExecutions,
  manualStopFlags,
  pendingApprovals,
  stopTaskExecution,
  toolCallToTaskMap,
} from "../ai-task-control";

describe("stopTaskExecution", () => {
  afterEach(() => {
    abortControllers.clear();
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
    pendingApprovals.set("tool-call-1", (value: boolean) => {
      approved = value;
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
