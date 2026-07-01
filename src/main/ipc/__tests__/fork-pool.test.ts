import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SubAgentContract,
  SubAgentReport,
} from "../../core/agent/sub-agent-contract";

interface MockRun {
  /** Resolves when this runner should complete. Defaults to immediate. */
  done: Promise<void>;
  status: SubAgentReport["status"];
  error?: string;
  observedTaskId?: string;
}

const scheduled: MockRun[] = [];
let cursor = 0;
const inFlight = { now: 0, max: 0 };

vi.mock("../fork-skill-runner", () => ({
  createForkSkillRunner: vi.fn((deps: { taskId: string }) => {
    return async (
      _opts: unknown,
    ): Promise<{
      agentId: string;
      status: SubAgentReport["status"];
      resultQuality: SubAgentReport["resultQuality"];
      summary: string;
      usage: SubAgentReport["usage"];
      toolCallCount: number;
      durationMs: number;
      error?: string;
    }> => {
      const idx = cursor++;
      const run = scheduled[idx];
      run.observedTaskId = deps.taskId;
      inFlight.now++;
      if (inFlight.now > inFlight.max) inFlight.max = inFlight.now;
      try {
        await run.done;
        return {
          agentId: deps.taskId,
          status: run.status,
          resultQuality: run.status === "ok" ? "complete" : "no_result",
          summary: `result-${idx}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCallCount: 0,
          durationMs: 1,
          error: run.error,
        };
      } finally {
        inFlight.now--;
      }
    };
  }),
}));

import { runForkBatch } from "../fork-pool";

function mkContract(idx: number): SubAgentContract {
  return {
    goal: `task-${idx}`,
    input: { prompt: `prompt-${idx}` },
    output: { format: "summary" },
    termination: {},
  };
}

function fakeSender(): WebContents {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

function makeDeferred(): { done: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return { done, resolve };
}

describe("runForkBatch", () => {
  beforeEach(() => {
    scheduled.length = 0;
    cursor = 0;
    inFlight.now = 0;
    inFlight.max = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    scheduled.length = 0;
  });

  it("returns empty reports for empty items", async () => {
    const result = await runForkBatch(
      [],
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: new AbortController().signal,
      },
      { concurrency: 3 },
    );
    expect(result.reports).toEqual([]);
    expect(result.forkBatchId).toMatch(/^batch-/);
  });

  it("honors concurrency cap — at most N runners in flight", async () => {
    const deferreds = Array.from({ length: 5 }, () => makeDeferred());
    for (const d of deferreds) {
      scheduled.push({ done: d.done, status: "ok" });
    }
    const items = Array.from({ length: 5 }, (_, i) => ({
      contract: mkContract(i),
      systemPrompt: "sys",
      workspacePath: "/ws",
    }));

    const batchP = runForkBatch(
      items,
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: new AbortController().signal,
      },
      { concurrency: 2 },
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight.max).toBeLessThanOrEqual(2);

    for (const d of deferreds) {
      d.resolve();
      await Promise.resolve();
    }

    const result = await batchP;
    expect(result.reports).toHaveLength(5);
    expect(result.reports.every((r) => r.status === "ok")).toBe(true);
    expect(inFlight.max).toBe(2);
  });

  it("returns reports in input order, not completion order", async () => {
    const deferreds = [0, 1, 2].map(() => makeDeferred());
    for (const d of deferreds) scheduled.push({ done: d.done, status: "ok" });

    const items = [0, 1, 2].map((i) => ({
      contract: mkContract(i),
      systemPrompt: "sys",
      workspacePath: "/ws",
    }));

    const batchP = runForkBatch(
      items,
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: new AbortController().signal,
      },
      { concurrency: 3 },
    );

    deferreds[2].resolve();
    deferreds[1].resolve();
    deferreds[0].resolve();

    const result = await batchP;
    expect(result.reports.map((r) => r.summary)).toEqual([
      "result-0",
      "result-1",
      "result-2",
    ]);
  });

  it("failFast=true cascades abort and synthesizes cancelled reports", async () => {
    const d0 = makeDeferred();
    const d1 = makeDeferred();
    const d2 = makeDeferred();
    const d3 = makeDeferred();
    scheduled.push({ done: d0.done, status: "failed", error: "boom" });
    scheduled.push({ done: d1.done, status: "ok" });
    scheduled.push({ done: d2.done, status: "ok" });
    scheduled.push({ done: d3.done, status: "ok" });

    const items = [0, 1, 2, 3].map((i) => ({
      contract: mkContract(i),
      systemPrompt: "sys",
      workspacePath: "/ws",
    }));

    const batchP = runForkBatch(
      items,
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: new AbortController().signal,
      },
      { concurrency: 2, failFast: true },
    );

    d0.resolve();
    d1.resolve();
    d2.resolve();
    d3.resolve();

    const result = await batchP;
    expect(result.reports[0].status).toBe("failed");
    const tail = [result.reports[2].status, result.reports[3].status];
    expect(tail.some((s) => s === "cancelled")).toBe(true);
  });

  it("parent abort short-circuits the batch", async () => {
    const items = [0, 1].map((i) => ({
      contract: mkContract(i),
      systemPrompt: "sys",
      workspacePath: "/ws",
    }));
    const parent = new AbortController();
    parent.abort();

    const result = await runForkBatch(
      items,
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: parent.signal,
      },
      { concurrency: 2 },
    );

    expect(
      result.reports.every(
        (r) => r.status === "cancelled" || r.status === "failed",
      ),
    ).toBe(true);
  });

  it("uses provided forkBatchId when supplied", async () => {
    const result = await runForkBatch(
      [],
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: new AbortController().signal,
      },
      { forkBatchId: "my-batch" },
    );
    expect(result.forkBatchId).toBe("my-batch");
  });

  it("synthesizes a failed report when a runner throws", async () => {
    let rejectFn!: (err: Error) => void;
    const done = new Promise<void>((_, reject) => {
      rejectFn = reject;
    });
    scheduled.push({ done, status: "ok" });

    const batchP = runForkBatch(
      [
        {
          contract: mkContract(0),
          systemPrompt: "sys",
          workspacePath: "/ws",
        },
      ],
      {
        sender: fakeSender(),
        workspacePath: "/ws",
        parentSignal: new AbortController().signal,
      },
      { concurrency: 1 },
    );
    rejectFn(new Error("crash"));

    const result = await batchP;
    expect(result.reports[0].status).toBe("failed");
    expect(result.reports[0].error).toBe("crash");
  });
});
