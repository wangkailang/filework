/**
 * CiWatcher unit tests (M12).
 *
 * Each test builds a fresh CiWatcher instance via __test__.CiWatcher to
 * stay isolated from the module-level singleton. Uses vi.useFakeTimers()
 * so the 30s tick + 5min timeout fire deterministically.
 */

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CIRunDetail,
  Workspace,
  WorkspaceSCM,
} from "../../core/workspace/types";
import { __test__, TICK_MS, TIMEOUT_MS } from "../ci-watcher";

const buildSender = (overrides: { destroyed?: boolean } = {}) => {
  const send = vi.fn();
  return {
    sender: {
      isDestroyed: () => overrides.destroyed ?? false,
      send,
    } as unknown as WebContents,
    send,
  };
};

const buildWorkspace = (
  getCIRun?: (input: { id: string }) => Promise<CIRunDetail>,
  id = "github:acme/app@main",
): Workspace =>
  ({
    id,
    kind: "github",
    root: "/tmp/x",
    fs: {} as never,
    exec: {} as never,
    scm: getCIRun ? ({ getCIRun } as unknown as WorkspaceSCM) : undefined,
  }) as Workspace;

const completedRun = (overrides: Partial<CIRunDetail> = {}): CIRunDetail => ({
  id: "42",
  name: "CI",
  status: "completed",
  conclusion: "success",
  ref: "main",
  commitSha: "abc",
  url: "https://gh/runs/42",
  startedAt: "2026-05-10T10:00:00Z",
  completedAt: "2026-05-10T10:05:00Z",
  event: "push",
  durationSec: 300,
  jobsCount: 1,
  ...overrides,
});

const inProgressRun = (): CIRunDetail => ({
  ...completedRun(),
  status: "in_progress",
  conclusion: null,
  completedAt: null,
});

describe("CiWatcher.subscribe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when the workspace lacks getCIRun", () => {
    const watcher = new __test__.CiWatcher();
    const { sender } = buildSender();
    const watchKey = watcher.subscribe({
      workspace: buildWorkspace(),
      runId: "42",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });
    expect(watchKey).toBeNull();
    expect(watcher.size()).toBe(0);
  });

  it("polls every TICK_MS and emits ai:ci-run-done when run completes", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const getCIRun = vi
      .fn()
      .mockResolvedValueOnce(inProgressRun())
      .mockResolvedValueOnce(completedRun());
    const ws = buildWorkspace(getCIRun);

    const watchKey = watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });
    expect(watchKey).toBe("github:acme/app@main:42");
    expect(watcher.size()).toBe(1);

    // First tick → in_progress → no event, still subscribed
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(getCIRun).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(watcher.size()).toBe(1);

    // Second tick → completed → emit + cleanup
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(getCIRun).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("ai:ci-run-done", {
      id: "t-1",
      runId: "42",
      workspaceId: "github:acme/app@main",
      conclusion: "success",
      url: "https://gh/runs/42",
      name: "CI",
      durationSec: 300,
    });
    expect(watcher.size()).toBe(0);
  });

  it("emits ai:ci-run-timeout after TIMEOUT_MS and unsubscribes", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace(getCIRun);

    watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const timeoutCalls = send.mock.calls.filter(
      (c) => c[0] === "ai:ci-run-timeout",
    );
    expect(timeoutCalls).toHaveLength(1);
    expect(timeoutCalls[0]?.[1]).toEqual({
      id: "t-1",
      runId: "42",
      workspaceId: "github:acme/app@main",
      elapsedMs: TIMEOUT_MS,
    });
    expect(watcher.size()).toBe(0);
  });

  it("dedupes second subscribe for the same workspace+runId", () => {
    const watcher = new __test__.CiWatcher();
    const { sender } = buildSender();
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace(getCIRun);
    const signal = new AbortController().signal;

    const k1 = watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal,
    });
    const k2 = watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal,
    });
    expect(k1).toBe(k2);
    expect(watcher.size()).toBe(1);
  });

  it("cleanup happens when AbortSignal fires", () => {
    const watcher = new __test__.CiWatcher();
    const { sender } = buildSender();
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace(getCIRun);
    const ctrl = new AbortController();

    watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal: ctrl.signal,
    });
    expect(watcher.size()).toBe(1);
    ctrl.abort();
    expect(watcher.size()).toBe(0);
  });

  it("unsubscribes on next tick when sender is destroyed", async () => {
    const watcher = new __test__.CiWatcher();
    let destroyed = false;
    const send = vi.fn();
    const sender = {
      isDestroyed: () => destroyed,
      send,
    } as unknown as WebContents;
    const getCIRun = vi.fn().mockResolvedValue(inProgressRun());
    const ws = buildWorkspace(getCIRun);

    watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });
    expect(watcher.size()).toBe(1);

    destroyed = true;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(watcher.size()).toBe(0);
    // No event emitted because sender is destroyed.
    expect(send).not.toHaveBeenCalled();
  });

  it("network errors in getCIRun are swallowed and the watcher keeps polling", async () => {
    const watcher = new __test__.CiWatcher();
    const { sender, send } = buildSender();
    const getCIRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(completedRun());
    const ws = buildWorkspace(getCIRun);

    watcher.subscribe({
      workspace: ws,
      runId: "42",
      sender,
      taskId: "t-1",
      signal: new AbortController().signal,
    });

    // Suppress the expected console.warn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First tick → throws, no event, still subscribed
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(send).not.toHaveBeenCalled();
    expect(watcher.size()).toBe(1);
    expect(warn).toHaveBeenCalled();

    // Second tick → completed → emit + cleanup
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(watcher.size()).toBe(0);
    warn.mockRestore();
  });
});
