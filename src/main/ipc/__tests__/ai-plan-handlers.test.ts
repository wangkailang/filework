import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredHandlers = new Map<string, Function>();

const planTaskMock = vi.fn();
const cleanupTaskMock = vi.fn();
const getAIModelByConfigIdMock = vi.fn(() => ({ provider: "mock-model" }));
const abortControllers = new Map<string, AbortController>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

vi.mock("../../planner", () => ({
  needsPlanning: vi.fn(() => false),
  planTask: planTaskMock,
}));

vi.mock("../ai-models", () => ({
  getAIModelByConfigId: getAIModelByConfigIdMock,
  isAuthError: vi.fn(() => false),
}));

vi.mock("../ai-tool-permissions", () => ({
  buildTools: vi.fn(() => ({})),
}));

vi.mock("../ai-tools", () => ({
  safeTools: {
    listDirectory: {},
    readFile: {},
    directoryStats: {},
  },
}));

vi.mock("../ai-task-control", () => ({
  abortControllers,
  cleanupTask: cleanupTaskMock,
}));

vi.mock("../../db", () => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../planner/executor", () => ({
  executePlan: vi.fn(),
  cancelPlan: vi.fn(),
}));

describe("registerPlanHandlers / ai:generatePlan", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    abortControllers.clear();
    planTaskMock.mockReset();
    cleanupTaskMock.mockReset();
    getAIModelByConfigIdMock.mockClear();
    vi.resetModules();
  });

  it("emits stream lifecycle events and passes abortSignal into planTask", async () => {
    const plan = {
      id: "plan-1",
      prompt: "do something",
      goal: "goal",
      steps: [],
      status: "draft",
      workspacePath: "/tmp/workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    planTaskMock.mockResolvedValue(plan);

    const { registerPlanHandlers } = await import("../ai-plan-handlers");
    registerPlanHandlers();

    const handler = registeredHandlers.get("ai:generatePlan");
    expect(handler).toBeTypeOf("function");

    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };

    const result = await handler!(
      { sender } as unknown as Electron.IpcMainInvokeEvent,
      {
        prompt: "make a plan",
        workspacePath: "/tmp/workspace",
      },
    );

    expect(getAIModelByConfigIdMock).toHaveBeenCalledOnce();
    expect(planTaskMock).toHaveBeenCalledOnce();

    const passedAbortSignal = planTaskMock.mock.calls[0][4];
    expect(passedAbortSignal).toBeInstanceOf(AbortSignal);

    const streamStartCall = sender.send.mock.calls.find((c) => c[0] === "ai:stream-start");
    const planReadyCall = sender.send.mock.calls.find((c) => c[0] === "ai:plan-ready");
    const streamDoneCall = sender.send.mock.calls.find((c) => c[0] === "ai:stream-done");

    expect(streamStartCall).toBeTruthy();
    expect(planReadyCall).toBeTruthy();
    expect(streamDoneCall).toBeTruthy();

    const generatedTaskId = streamStartCall?.[1]?.id;
    expect(planReadyCall?.[1]).toEqual({ id: generatedTaskId, plan });
    expect(streamDoneCall?.[1]).toEqual({ id: generatedTaskId });
    expect(result).toEqual({ id: generatedTaskId, plan });
    expect(cleanupTaskMock).toHaveBeenCalledWith(generatedTaskId);
  });

  it("returns cancelled=true and emits stream-done when plan generation is aborted", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    planTaskMock.mockRejectedValue(abortError);

    const { registerPlanHandlers } = await import("../ai-plan-handlers");
    registerPlanHandlers();

    const handler = registeredHandlers.get("ai:generatePlan");
    expect(handler).toBeTypeOf("function");

    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };

    const result = await handler!(
      { sender } as unknown as Electron.IpcMainInvokeEvent,
      {
        prompt: "make a plan",
        workspacePath: "/tmp/workspace",
      },
    );

    const streamStartCall = sender.send.mock.calls.find((c) => c[0] === "ai:stream-start");
    const streamDoneCall = sender.send.mock.calls.find((c) => c[0] === "ai:stream-done");
    const planErrorCall = sender.send.mock.calls.find((c) => c[0] === "ai:plan-error");

    expect(streamStartCall).toBeTruthy();
    expect(streamDoneCall).toBeTruthy();
    expect(planErrorCall).toBeFalsy();

    const generatedTaskId = streamStartCall?.[1]?.id;
    expect(streamDoneCall?.[1]).toEqual({ id: generatedTaskId });
    expect(result).toEqual({ id: generatedTaskId, cancelled: true });
    expect(cleanupTaskMock).toHaveBeenCalledWith(generatedTaskId);
  });
});
