/**
 * CiWatcher.subscribeAfterDispatch (M13).
 *
 * Same fake-timer harness as ci-watcher.test.ts. Exercises the
 * 3-attempt × 2s retry loop that resolves a workflow_dispatch's runId
 * via listCIRuns, then falls through to subscribe().
 */

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CIRunDetail,
  CIRunSummary,
  Workspace,
  WorkspaceSCM,
} from "../../core/workspace/types";
import { __test__, RESOLVE_RETRY_MS } from "../ci-watcher";

const buildSender = () => {
  const send = vi.fn();
  return {
    sender: {
      isDestroyed: () => false,
      send,
    } as unknown as WebContents,
    send,
  };
};

const buildWorkspace = (
  scm: Partial<WorkspaceSCM>,
  id = "github:acme/app@main",
): Workspace =>
  ({
    id,
    kind: "github",
    root: "/tmp/x",
    fs: {} as never,
    exec: {} as never,
    scm: scm as WorkspaceSCM,
  }) as Workspace;

const summary = (overrides: Partial<CIRunSummary> = {}): CIRunSummary => ({
  id: "42",
  name: "CI",
  status: "in_progress",
  conclusion: null,
  ref: "main",
  commitSha: "abc",
  url: "https://gh/runs/42",
  startedAt: "2026-05-10T10:00:00Z",
  completedAt: null,
  ...overrides,
});

const inProgressRun = (): CIRunDetail => ({
  ...summary(),
  status: "in_progress",
  event: "workflow_dispatch",
  durationSec: null,
  jobsCount: 1,
});

describe("CiWatcher.subscribeAfterDispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when the workspace lacks listCIRuns", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const result = await watcher.subscribeAfterDispatch({
      workspace: buildWorkspace({}),
      ref: "main",
      workflowFile: "ci.yml",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(watcher.size()).toBe(0);
  });

  it("subscribes immediately when listCIRuns returns a run on the first try", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const listCIRuns = vi.fn().mockResolvedValue([summary({ id: "42" })]);
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace({ listCIRuns, getCIRun });

    const promise = watcher.subscribeAfterDispatch({
      workspace: ws,
      ref: "main",
      workflowFile: "ci.yml",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });
    const watchKey = await promise;

    expect(watchKey).toBe("github:acme/app@main:42");
    expect(listCIRuns).toHaveBeenCalledTimes(1);
    expect(listCIRuns).toHaveBeenCalledWith({
      ref: "main",
      status: "in_progress",
      limit: 1,
    });
    expect(watcher.size()).toBe(1);
    // No resolve-failed event when we found a run.
    expect(send).not.toHaveBeenCalled();
  });

  it("retries up to RESOLVE_MAX_ATTEMPTS and subscribes on second hit", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const listCIRuns = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([summary({ id: "99" })]);
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace({ listCIRuns, getCIRun });

    const promise = watcher.subscribeAfterDispatch({
      workspace: ws,
      ref: "main",
      workflowFile: "ci.yml",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });

    // First attempt fires immediately; second is gated on the delay.
    await vi.advanceTimersByTimeAsync(RESOLVE_RETRY_MS);
    const watchKey = await promise;

    expect(listCIRuns).toHaveBeenCalledTimes(2);
    expect(watchKey).toBe("github:acme/app@main:99");
    expect(send).not.toHaveBeenCalled();
  });

  it("emits ai:ci-dispatch-resolve-failed after exhausting retries", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const listCIRuns = vi.fn().mockResolvedValue([]);
    const ws = buildWorkspace({ listCIRuns });

    const promise = watcher.subscribeAfterDispatch({
      workspace: ws,
      ref: "main",
      workflowFile: "ci.yml",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });

    // Burn through both inter-attempt delays.
    await vi.advanceTimersByTimeAsync(RESOLVE_RETRY_MS * 2);
    const watchKey = await promise;

    expect(listCIRuns).toHaveBeenCalledTimes(3);
    expect(watchKey).toBeNull();
    expect(watcher.size()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("ai:ci-dispatch-resolve-failed", {
      id: "t-1",
      workspaceId: "github:acme/app@main",
      ref: "main",
      workflowFile: "ci.yml",
    });
  });

  it("aborts mid-retry when the signal flips", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const listCIRuns = vi.fn().mockResolvedValue([]);
    const ws = buildWorkspace({ listCIRuns });
    const ctrl = new AbortController();

    const promise = watcher.subscribeAfterDispatch({
      workspace: ws,
      ref: "main",
      workflowFile: "ci.yml",
      sender,
      taskId: "t-1",
      signal: ctrl.signal,
    });

    // First listCIRuns ran (attempt 0). Abort before the 2s delay completes.
    ctrl.abort();
    const result = await promise;

    expect(result).toBeNull();
    // Only the first attempt fired.
    expect(listCIRuns).toHaveBeenCalledTimes(1);
    // No resolve-failed event when the user cancelled.
    expect(send).not.toHaveBeenCalled();
    expect(watcher.size()).toBe(0);
  });

  it("swallows network errors and keeps trying", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const listCIRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce([summary({ id: "7" })]);
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace({ listCIRuns, getCIRun });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = watcher.subscribeAfterDispatch({
      workspace: ws,
      ref: "main",
      workflowFile: "ci.yml",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(RESOLVE_RETRY_MS);
    const watchKey = await promise;

    expect(listCIRuns).toHaveBeenCalledTimes(2);
    expect(watchKey).toBe("github:acme/app@main:7");
    expect(warn).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
