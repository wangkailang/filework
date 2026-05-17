import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPatternStoreForTests,
  appendPattern,
  getPatternStorePath,
  initPatternStore,
  readAllPatterns,
} from "../pattern-store";

describe("pattern-store", () => {
  let dir: string;
  let storeFile: string;

  beforeEach(async () => {
    __resetPatternStoreForTests();
    dir = await mkdtemp(join(tmpdir(), "filework-pattern-store-"));
    storeFile = join(dir, "patterns.jsonl");
  });

  afterEach(async () => {
    __resetPatternStoreForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("is a no-op when no path has been configured", async () => {
    expect(getPatternStorePath()).toBeUndefined();
    await appendPattern({
      kind: "task",
      ts: new Date().toISOString(),
      taskId: "t1",
      status: "completed",
      durationMs: 100,
    });
    expect(await readAllPatterns()).toEqual([]);
  });

  it("appends and reads back records as JSONL after init", async () => {
    initPatternStore(storeFile);
    const ts = "2026-05-17T13:00:00.000Z";

    await appendPattern({
      kind: "subagent",
      ts,
      agentId: "sub-1",
      contractGoal: "extract titles",
      status: "ok",
      summary: "did it",
      toolCallCount: 2,
      durationMs: 1000,
    });

    await appendPattern({
      kind: "task",
      ts,
      taskId: "t1",
      status: "completed",
      durationMs: 4200,
      totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });

    const records = await readAllPatterns();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "subagent",
      agentId: "sub-1",
      status: "ok",
    });
    expect(records[1]).toMatchObject({
      kind: "task",
      taskId: "t1",
      totalUsage: { inputTokens: 5 },
    });
  });

  it("serializes concurrent appends without interleaving", async () => {
    initPatternStore(storeFile);

    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendPattern({
          kind: "task",
          ts: new Date().toISOString(),
          taskId: `t-${i}`,
          status: "completed",
          durationMs: i,
        }),
      ),
    );

    const records = await readAllPatterns();
    expect(records).toHaveLength(N);
    const ids = new Set(
      records.map((r) => (r.kind === "task" ? r.taskId : "")),
    );
    expect(ids.size).toBe(N);
  });

  it("readAllPatterns returns [] when the file does not exist yet", async () => {
    initPatternStore(storeFile);
    expect(await readAllPatterns()).toEqual([]);
  });
});
