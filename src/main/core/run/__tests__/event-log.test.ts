import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlRunEventLog } from "../event-log";

describe("JsonlRunEventLog", () => {
  let rootDir: string;
  let log: JsonlRunEventLog;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "fw-run-events-"));
    log = new JsonlRunEventLog(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("appends stream events and replays from a start index", () => {
    log.appendEvent({
      taskId: "task/with/slashes",
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      index: 0,
      channel: "ai:stream-delta",
      payload: { delta: "one" },
      timestamp: "2026-06-24T01:00:00.000Z",
    });
    log.appendEvent({
      taskId: "task/with/slashes",
      sessionId: "session-a",
      assistantMessageId: "assistant-a",
      index: 1,
      channel: "ai:stream-done",
      payload: { id: "task/with/slashes" },
      timestamp: "2026-06-24T01:00:01.000Z",
    });

    expect(log.getEventCount("task/with/slashes")).toBe(2);
    expect(log.readEvents("task/with/slashes", 1)).toEqual([
      {
        kind: "event",
        schemaVersion: 1,
        taskId: "task/with/slashes",
        sessionId: "session-a",
        assistantMessageId: "assistant-a",
        index: 1,
        channel: "ai:stream-done",
        payload: { id: "task/with/slashes" },
        timestamp: "2026-06-24T01:00:01.000Z",
      },
    ]);
  });

  it("ignores corrupt lines without losing valid replay records", async () => {
    log.appendEvent({
      taskId: "task-corrupt",
      index: 0,
      channel: "ai:stream-delta",
      payload: { delta: "before" },
      timestamp: "2026-06-24T01:00:00.000Z",
    });
    await appendFile(log.filePathForTask("task-corrupt"), "not-json\n");
    log.appendEvent({
      taskId: "task-corrupt",
      index: 1,
      channel: "ai:stream-delta",
      payload: { delta: "after" },
      timestamp: "2026-06-24T01:00:01.000Z",
    });

    expect(log.readEvents("task-corrupt", 0).map((e) => e.payload)).toEqual([
      { delta: "before" },
      { delta: "after" },
    ]);
    await expect(
      readFile(log.filePathForTask("task-corrupt"), "utf8"),
    ).resolves.toContain("not-json");
  });

  it("deletes a task event log", async () => {
    log.appendEvent({
      taskId: "task-delete",
      index: 0,
      channel: "ai:stream-delta",
      payload: { delta: "before cleanup" },
      timestamp: "2026-06-24T01:00:00.000Z",
    });

    log.deleteTask("task-delete");

    expect(log.readEvents("task-delete", 0)).toEqual([]);
    await expect(stat(log.filePathForTask("task-delete"))).rejects.toThrow();
  });

  it("prunes jsonl logs older than the cutoff", async () => {
    log.appendEvent({
      taskId: "task-old",
      index: 0,
      channel: "ai:stream-delta",
      payload: { delta: "old" },
      timestamp: "2026-06-24T01:00:00.000Z",
    });
    log.appendEvent({
      taskId: "task-new",
      index: 0,
      channel: "ai:stream-delta",
      payload: { delta: "new" },
      timestamp: "2026-06-24T01:00:00.000Z",
    });
    const oldDate = new Date("2026-06-20T00:00:00.000Z");
    const newDate = new Date("2026-06-24T00:00:00.000Z");
    await utimes(log.filePathForTask("task-old"), oldDate, oldDate);
    await utimes(log.filePathForTask("task-new"), newDate, newDate);

    const pruned = log.pruneOlderThan(new Date("2026-06-22T00:00:00.000Z"));

    expect(pruned).toBe(1);
    expect(log.readEvents("task-old", 0)).toEqual([]);
    expect(log.readEvents("task-new", 0).map((event) => event.payload)).toEqual(
      [{ delta: "new" }],
    );
  });

  it("compacts adjacent stream deltas while preserving replay cursor indexes", async () => {
    log.appendEvent({
      taskId: "task-compact",
      index: 0,
      channel: "ai:stream-start",
      payload: { id: "task-compact" },
    });
    log.appendEvent({
      taskId: "task-compact",
      index: 1,
      channel: "ai:stream-delta",
      payload: { id: "task-compact", delta: "hello " },
    });
    log.appendEvent({
      taskId: "task-compact",
      index: 2,
      channel: "ai:stream-delta",
      payload: { id: "task-compact", delta: "world" },
    });
    log.appendEvent({
      taskId: "task-compact",
      index: 3,
      channel: "ai:stream-reasoning",
      payload: { id: "task-compact", messageId: "r1", delta: "think " },
    });
    log.appendEvent({
      taskId: "task-compact",
      index: 4,
      channel: "ai:stream-reasoning",
      payload: { id: "task-compact", messageId: "r1", delta: "more" },
    });
    log.appendEvent({
      taskId: "task-compact",
      index: 5,
      channel: "ai:stream-tool-call",
      payload: { id: "task-compact", toolCallId: "tool-1" },
    });

    const result = log.compactTask("task-compact");

    expect(result).toEqual({ before: 6, after: 4 });
    expect(log.getEventCount("task-compact")).toBe(6);
    expect(
      log.readEvents("task-compact", 0).map((event) => event.index),
    ).toEqual([0, 2, 4, 5]);
    expect(
      log.readEvents("task-compact", 0).map((event) => event.payload),
    ).toEqual([
      { id: "task-compact" },
      { id: "task-compact", delta: "hello world" },
      { id: "task-compact", messageId: "r1", delta: "think more" },
      { id: "task-compact", toolCallId: "tool-1" },
    ]);
    expect(
      log.readEvents("task-compact", 5).map((event) => event.index),
    ).toEqual([5]);
  });
});
