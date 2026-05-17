import { describe, expect, it } from "vitest";

import { computeDiff, formatDiffMarkdown, type LoadedRun } from "../diff";
import type { FailureTag, QuestionResult, RunSummary } from "../types";

const mkResult = (
  taskId: string,
  passed: boolean,
  overrides: Partial<QuestionResult> = {},
): QuestionResult => ({
  taskId,
  level: 1,
  question: "?",
  attachment: null,
  groundTruth: "truth",
  predicted: passed ? "truth" : "wrong",
  passed,
  normalized: { groundTruth: "truth", predicted: passed ? "truth" : "wrong" },
  durationMs: 1000,
  toolCalls: [],
  stepCount: 0,
  reflectionFired: false,
  failureTags: passed ? [] : (["no_tool_calls"] as FailureTag[]),
  eventsPath: "",
  ...overrides,
});

const mkSummary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  config: {
    level: "1",
    limit: null,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    startedAt: "2026-05-17T19:00:00.000Z",
    finishedAt: "2026-05-17T19:30:00.000Z",
  },
  totals: { questions: 0, passed: 0, failed: 0 },
  accuracy: 0,
  byLevel: {},
  duration: { totalMs: 0, medianMs: 0 },
  cost: { totalUsd: 0, perQuestionMedianUsd: 0 },
  failureTags: {},
  ...overrides,
});

const mkRun = (
  dir: string,
  results: QuestionResult[],
  summaryOverrides: Partial<RunSummary> = {},
): LoadedRun => ({
  dir,
  summary: mkSummary(summaryOverrides),
  results,
  byTaskId: new Map(results.map((r) => [r.taskId, r])),
});

// ─── computeDiff ─────────────────────────────────────────────────────

describe("computeDiff", () => {
  it("detects newly passing questions", () => {
    const baseline = mkRun("/base", [
      mkResult("a", false),
      mkResult("b", true),
    ]);
    const current = mkRun("/cur", [mkResult("a", true), mkResult("b", true)]);
    const diff = computeDiff(baseline, current);
    expect(diff.newlyPassed.map((q) => q.taskId)).toEqual(["a"]);
    expect(diff.regressions).toHaveLength(0);
  });

  it("detects regressions and emphasises them", () => {
    const baseline = mkRun("/base", [mkResult("a", true), mkResult("b", true)]);
    const current = mkRun("/cur", [mkResult("a", true), mkResult("b", false)]);
    const diff = computeDiff(baseline, current);
    expect(diff.regressions.map((q) => q.taskId)).toEqual(["b"]);
    expect(diff.newlyPassed).toHaveLength(0);
  });

  it("computes accuracy delta and level deltas", () => {
    const baseline = mkRun(
      "/base",
      [mkResult("a", false), mkResult("b", false)],
      {
        accuracy: 0,
        byLevel: { "1": { n: 2, passed: 0, accuracy: 0 } },
      },
    );
    const current = mkRun("/cur", [mkResult("a", true), mkResult("b", false)], {
      accuracy: 0.5,
      byLevel: { "1": { n: 2, passed: 1, accuracy: 0.5 } },
    });
    const diff = computeDiff(baseline, current);
    expect(diff.accuracyDelta).toBeCloseTo(0.5, 6);
    expect(diff.byLevelDelta["1"].delta).toBeCloseTo(0.5, 6);
  });

  it("computes failure-tag deltas sorted by |Δ| then by current count", () => {
    const baseline = mkRun("/base", [
      mkResult("a", false, { failureTags: ["no_tool_calls"] as FailureTag[] }),
      mkResult("b", false, { failureTags: ["no_tool_calls"] as FailureTag[] }),
      mkResult("c", false, { failureTags: ["tool_error"] as FailureTag[] }),
    ]);
    const current = mkRun("/cur", [
      mkResult("a", true),
      mkResult("b", true),
      mkResult("c", false, { failureTags: ["tool_error"] as FailureTag[] }),
    ]);
    const diff = computeDiff(baseline, current);
    // no_tool_calls dropped by 2; tool_error unchanged. no_tool_calls first.
    expect(diff.failureTagDeltas[0].tag).toBe("no_tool_calls");
    expect(diff.failureTagDeltas[0].delta).toBe(-2);
  });

  it("flags added / removed when filter changes between runs", () => {
    const baseline = mkRun("/base", [
      mkResult("a", true),
      mkResult("b", true),
      mkResult("c", false),
    ]);
    const current = mkRun("/cur", [mkResult("a", true), mkResult("d", true)]);
    const diff = computeDiff(baseline, current);
    expect(diff.removed.map((q) => q.taskId).sort()).toEqual(["b", "c"]);
    expect(diff.added.map((q) => q.taskId)).toEqual(["d"]);
  });

  it("reports null costDelta when both runs are zero-cost (unpriced)", () => {
    const baseline = mkRun("/base", [mkResult("a", true)], {
      cost: { totalUsd: 0, perQuestionMedianUsd: 0 },
    });
    const current = mkRun("/cur", [mkResult("a", true)], {
      cost: { totalUsd: 0, perQuestionMedianUsd: 0 },
    });
    const diff = computeDiff(baseline, current);
    expect(diff.costDeltaUsd).toBeNull();
  });

  it("computes a non-null costDelta when either run has cost data", () => {
    const baseline = mkRun("/base", [mkResult("a", true)], {
      cost: { totalUsd: 1.2, perQuestionMedianUsd: 0.4 },
    });
    const current = mkRun("/cur", [mkResult("a", true)], {
      cost: { totalUsd: 1.5, perQuestionMedianUsd: 0.5 },
    });
    const diff = computeDiff(baseline, current);
    expect(diff.costDeltaUsd).toBeCloseTo(0.3, 6);
  });
});

// ─── formatDiffMarkdown ──────────────────────────────────────────────

describe("formatDiffMarkdown", () => {
  it("emits an accuracy delta line with the right sign", () => {
    const baseline = mkRun("/base", [mkResult("a", false)], { accuracy: 0 });
    const current = mkRun("/cur", [mkResult("a", true)], { accuracy: 1 });
    const md = formatDiffMarkdown(computeDiff(baseline, current));
    expect(md).toContain("+100.0 pp");
  });

  it("includes the ⚠️ banner only when there are regressions", () => {
    const noRegress = formatDiffMarkdown(
      computeDiff(
        mkRun("/base", [mkResult("a", false)]),
        mkRun("/cur", [mkResult("a", true)]),
      ),
    );
    expect(noRegress).not.toContain("⚠️");
    expect(noRegress).toContain("None — no questions went from pass to fail");

    const withRegress = formatDiffMarkdown(
      computeDiff(
        mkRun("/base", [mkResult("a", true)]),
        mkRun("/cur", [mkResult("a", false)]),
      ),
    );
    expect(withRegress).toContain("⚠️ Regressions");
  });

  it("includes the Coverage drift section only when the question set changed", () => {
    const same = formatDiffMarkdown(
      computeDiff(
        mkRun("/base", [mkResult("a", false)]),
        mkRun("/cur", [mkResult("a", true)]),
      ),
    );
    expect(same).not.toContain("Coverage drift");

    const drifted = formatDiffMarkdown(
      computeDiff(
        mkRun("/base", [mkResult("a", true)]),
        mkRun("/cur", [mkResult("b", true)]),
      ),
    );
    expect(drifted).toContain("Coverage drift");
  });
});
