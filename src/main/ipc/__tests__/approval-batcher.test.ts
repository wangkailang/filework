import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getBatcherState,
  __resetBatcherForTests,
  __settleByToolCallIdForTests,
  cancelBatchesForTask,
  enqueueForBatch,
  settleBatch,
} from "../approval-batcher";
import {
  __resetToolWhitelistCacheForTests,
  isToolPersistentlyWhitelisted,
} from "../tool-whitelist";

interface StubSender {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
}

function makeSender(): StubSender {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  };
}

const toolName = "deleteFile";

const flushedBatchIds = (sender: StubSender): string[] =>
  sender.send.mock.calls
    .filter((c) => c[0] === "ai:stream-tool-batch-approval")
    .map((c) => (c[1] as { batchId: string }).batchId);

const lastBatchEvent = (sender: StubSender) => {
  const calls = sender.send.mock.calls.filter(
    (c) => c[0] === "ai:stream-tool-batch-approval",
  );
  return calls[calls.length - 1]?.[1] as
    | {
        id: string;
        batchId: string;
        toolName: string;
        entries: Array<{ toolCallId: string; description: string }>;
      }
    | undefined;
};

describe("approval-batcher", () => {
  beforeEach(() => {
    __resetBatcherForTests();
    __resetToolWhitelistCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetBatcherForTests();
    __resetToolWhitelistCacheForTests();
  });

  it("coalesces N concurrent calls into one IPC event with N entries", async () => {
    vi.useFakeTimers();
    const sender = makeSender();

    const promises = Array.from({ length: 14 }, (_, i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "coalesce-test",
        toolName,
        toolCallId: `c-${i}`,
        args: { path: `/tmp/f${i}.log` },
        description: `删除 /tmp/f${i}.log`,
      }),
    );

    expect(__getBatcherState().bufferCount).toBe(1);
    expect(flushedBatchIds(sender)).toHaveLength(0);

    vi.advanceTimersByTime(300);
    const ev = lastBatchEvent(sender);
    expect(ev).toBeDefined();
    expect(ev?.toolName).toBe(toolName);
    expect(ev?.entries).toHaveLength(14);
    expect(__getBatcherState().bufferCount).toBe(0);
    expect(__getBatcherState().pendingBatchCount).toBe(1);

    // 带「始终允许」(remember=true)批准,顺带验证白名单写入。
    settleBatch(ev?.batchId as string, true, true);
    const results = await Promise.all(promises);
    expect(results.every((r) => r === true)).toBe(true);
    expect(isToolPersistentlyWhitelisted(toolName)).toBe(true);
  });

  it("debounce splits late arrivals into a separate batch", async () => {
    vi.useFakeTimers();
    const sender = makeSender();

    enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "debounce-test",
      toolName,
      toolCallId: "x-1",
      args: { path: "/a/1" },
      description: "rm 1",
    });
    // Within the debounce window — same batch.
    vi.advanceTimersByTime(150);
    enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "debounce-test",
      toolName,
      toolCallId: "x-2",
      args: { path: "/a/2" },
      description: "rm 2",
    });
    vi.advanceTimersByTime(300);
    expect(flushedBatchIds(sender)).toHaveLength(1);

    // After flush, a fresh arrival starts a new batch.
    enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "debounce-test",
      toolName,
      toolCallId: "x-3",
      args: { path: "/a/3" },
      description: "rm 3",
    });
    vi.advanceTimersByTime(300);
    expect(flushedBatchIds(sender)).toHaveLength(2);
  });

  it("coalesces parallel arrivals staggered by filesystem jitter (~100ms apart)", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    // Simulate 6 deleteFile calls arriving with 100ms gaps each — the
    // realistic AI-SDK parallel-dispatch case where realpath() in
    // isInWorkspace introduces per-call I/O latency.
    for (let i = 0; i < 6; i++) {
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "jitter-test",
        toolName,
        toolCallId: `j-${i}`,
        args: { path: `/tmp/f${i}.log` },
        description: `rm /tmp/f${i}.log`,
      });
      vi.advanceTimersByTime(100); // gap < DEBOUNCE_MS (250)
    }
    // Final quiet period to trigger flush.
    vi.advanceTimersByTime(300);
    const ev = lastBatchEvent(sender);
    expect(ev).toBeDefined();
    expect(ev?.entries).toHaveLength(6);
    expect(flushedBatchIds(sender)).toHaveLength(1);
  });

  it("deny resolves all entries to false and does NOT whitelist", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const promises = [0, 1, 2].map((i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "deny-test",
        toolName,
        toolCallId: `d-${i}`,
        args: {},
        description: `rm ${i}`,
      }),
    );
    vi.advanceTimersByTime(300);
    const ev = lastBatchEvent(sender);
    settleBatch(ev?.batchId as string, false);
    const results = await Promise.all(promises);
    expect(results).toEqual([false, false, false]);
    expect(isToolPersistentlyWhitelisted(toolName)).toBe(false);
  });

  it("groups by (taskId, toolName) — different toolNames produce separate batches", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    for (let i = 0; i < 10; i++) {
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "group-test",
        toolName: "deleteFile",
        toolCallId: `del-${i}`,
        args: {},
        description: "del",
      });
    }
    for (let i = 0; i < 4; i++) {
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "group-test",
        toolName: "writeFile",
        toolCallId: `w-${i}`,
        args: {},
        description: "write",
      });
    }
    vi.advanceTimersByTime(300);
    const events = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-approval",
    );
    expect(events).toHaveLength(2);
    const sorted = events
      .map((c) => c[1] as { toolName: string; entries: unknown[] })
      .sort((a, b) => a.toolName.localeCompare(b.toolName));
    expect(sorted[0].toolName).toBe("deleteFile");
    expect(sorted[0].entries).toHaveLength(10);
    expect(sorted[1].toolName).toBe("writeFile");
    expect(sorted[1].entries).toHaveLength(4);
  });

  it("cancelBatchesForTask rejects all entries (buffered + flushed)", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const bufferingPromise = enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "cancel-test",
      toolName,
      toolCallId: "buf-1",
      args: {},
      description: "buf",
    });
    const flushedPromise = enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "cancel-test",
      toolName: "writeFile",
      toolCallId: "flushed-1",
      args: {},
      description: "flushed",
    });
    vi.advanceTimersByTime(300);

    cancelBatchesForTask("cancel-test");
    const [r1, r2] = await Promise.all([bufferingPromise, flushedPromise]);
    expect(r1).toBe(false);
    expect(r2).toBe(false);
    expect(__getBatcherState().bufferCount).toBe(0);
    expect(__getBatcherState().pendingBatchCount).toBe(0);
  });

  it("per-entry abort signal removes that entry without affecting siblings", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const promises = controllers.map((ctrl, i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "per-abort-test",
        toolName,
        toolCallId: `pa-${i}`,
        args: {},
        description: `entry ${i}`,
        abortSignal: ctrl.signal,
      }),
    );
    controllers[1].abort();
    vi.advanceTimersByTime(300);

    const ev = lastBatchEvent(sender);
    expect(ev?.entries).toHaveLength(2);
    settleBatch(ev?.batchId as string, true);
    const results = await Promise.all(promises);
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(false);
    expect(results[2]).toBe(true);
  });

  it("remember=true persists the tool to the global whitelist", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "persist-test",
      toolName,
      toolCallId: "p-0",
      args: { path: "/a/0" },
      description: "rm a0",
    });
    vi.advanceTimersByTime(300);
    const ev = lastBatchEvent(sender);

    expect(isToolPersistentlyWhitelisted(toolName)).toBe(false);
    settleBatch(ev?.batchId as string, true, true);
    expect(isToolPersistentlyWhitelisted(toolName)).toBe(true);
  });

  it("cascade-approves sibling batches when approved with remember=true", async () => {
    vi.useFakeTimers();
    const sender = makeSender();

    // Batch A: 2 deleteFile entries
    const promisesA = [0, 1].map((i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "cascade-test",
        toolName,
        toolCallId: `a-${i}`,
        args: { path: `/a/${i}` },
        description: `rm a${i}`,
      }),
    );
    vi.advanceTimersByTime(300); // flush A

    // Batch B (different timing): 3 more deleteFile entries
    const promisesB = [0, 1, 2].map((i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "cascade-test",
        toolName,
        toolCallId: `b-${i}`,
        args: { path: `/b/${i}` },
        description: `rm b${i}`,
      }),
    );
    vi.advanceTimersByTime(300); // flush B

    const events = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-approval",
    );
    expect(events).toHaveLength(2);
    const [aEvent, bEvent] = events.map(
      (c) => c[1] as { batchId: string; entries: unknown[] },
    );

    // User approves batch A with "始终允许" (remember=true).
    settleBatch(aEvent.batchId, true, true);

    // Batch B should auto-resolve via cascade.
    const aResults = await Promise.all(promisesA);
    const bResults = await Promise.all(promisesB);
    expect(aResults).toEqual([true, true]);
    expect(bResults).toEqual([true, true, true]);

    // Renderer should be notified that batch B was auto-approved.
    const cascadeEvents = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-auto-approved",
    );
    expect(cascadeEvents).toHaveLength(1);
    expect((cascadeEvents[0][1] as { batchId: string }).batchId).toBe(
      bEvent.batchId,
    );

    expect(isToolPersistentlyWhitelisted(toolName)).toBe(true);
  });

  it("plain approve (remember=false) neither whitelists nor cascades", async () => {
    vi.useFakeTimers();
    const sender = makeSender();

    // Batch A
    const promisesA = [0].map((i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "plain-approve-test",
        toolName,
        toolCallId: `pa-${i}`,
        args: { path: `/a/${i}` },
        description: `rm a${i}`,
      }),
    );
    vi.advanceTimersByTime(300); // flush A

    // Batch B (sibling, flushed separately)
    enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "plain-approve-test",
      toolName,
      toolCallId: "pb-0",
      args: { path: "/b/0" },
      description: "rm b0",
    });
    vi.advanceTimersByTime(300); // flush B

    const events = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-approval",
    );
    const [aEvent] = events.map((c) => c[1] as { batchId: string });

    // Plain 批准:只放行 A 显示的操作,不写白名单、不级联到 B。
    settleBatch(aEvent.batchId, true);

    const aResults = await Promise.all(promisesA);
    expect(aResults).toEqual([true]);
    // 未级联:B 仍待处理
    expect(__getBatcherState().pendingBatchCount).toBe(1);
    // 未级联通知
    const cascadeEvents = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-auto-approved",
    );
    expect(cascadeEvents).toHaveLength(0);
    // 未写白名单:后续同类调用仍需批准
    expect(isToolPersistentlyWhitelisted(toolName)).toBe(false);

    // 清理:取消 B 的未决 promise
    cancelBatchesForTask("plain-approve-test");
  });

  it("does NOT cascade-approve sibling batches when first is denied", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const promisesA = [0].map((i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "no-cascade-test",
        toolName,
        toolCallId: `na-${i}`,
        args: {},
        description: "a",
      }),
    );
    vi.advanceTimersByTime(300);
    const promisesB = [0].map((i) =>
      enqueueForBatch({
        sender: sender as unknown as WebContents,
        taskId: "no-cascade-test",
        toolName,
        toolCallId: `nb-${i}`,
        args: {},
        description: "b",
      }),
    );
    vi.advanceTimersByTime(300);

    const events = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-approval",
    );
    const [aEvent, _bEvent] = events.map((c) => c[1] as { batchId: string });

    // User denies batch A.
    settleBatch(aEvent.batchId, false);
    const aResults = await Promise.all(promisesA);
    expect(aResults).toEqual([false]);

    // Batch B must still be pending (not cascade-resolved on deny).
    expect(__getBatcherState().pendingBatchCount).toBe(1);
    // Clean up so the test doesn't leak the unresolved promise.
    // Need to grab batch B's id — it's the last batch event.
    const allEvents = sender.send.mock.calls.filter(
      (c) => c[0] === "ai:stream-tool-batch-approval",
    );
    const bId = (allEvents[allEvents.length - 1][1] as { batchId: string })
      .batchId;
    settleBatch(bId, false);
    await Promise.all(promisesB);
  });

  it("__settleByToolCallIdForTests flushes still-buffering entries", async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const p = enqueueForBatch({
      sender: sender as unknown as WebContents,
      taskId: "helper-test",
      toolName,
      toolCallId: "h-1",
      args: {},
      description: "h",
    });
    expect(__getBatcherState().bufferCount).toBe(1);
    expect(__settleByToolCallIdForTests("h-1", true)).toBe(true);
    expect(await p).toBe(true);
  });
});
