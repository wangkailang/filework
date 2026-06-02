import { describe, expect, it } from "vitest";

import {
  buildFailureReport,
  buildToolStats,
  buildToolUsageReport,
} from "../report";
import type { FailureTag, QuestionResult, RunSummary } from "../types";

const mkResult = (
  overrides: Partial<QuestionResult> & Pick<QuestionResult, "taskId">,
): QuestionResult => {
  const { taskId, ...rest } = overrides;
  return {
    taskId,
    level: 1,
    question: "?",
    attachment: null,
    groundTruth: "truth",
    predicted: "pred",
    passed: false,
    normalized: { groundTruth: "truth", predicted: "pred" },
    durationMs: 1000,
    toolCalls: [],
    stepCount: 0,
    reflectionFired: false,
    failureTags: [],
    eventsPath: "",
    ...rest,
  };
};

const mkSummary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  config: {
    level: "1",
    limit: null,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    startedAt: "2026-05-17T19:00:00.000Z",
    finishedAt: "2026-05-17T19:30:00.000Z",
  },
  totals: { questions: 10, passed: 5, failed: 5 },
  accuracy: 0.5,
  byLevel: { "1": { n: 10, passed: 5, accuracy: 0.5 } },
  duration: { totalMs: 100_000, medianMs: 10_000 },
  cost: { totalUsd: 0.42, perQuestionMedianUsd: 0.04 },
  failureTags: {},
  ...overrides,
});

// ─── buildFailureReport 构建失败报告 ──────────────────────────────────────────────

describe("buildFailureReport", () => {
  it("renders headline accuracy, cost, and model on the second line", () => {
    const md = buildFailureReport(
      [mkResult({ taskId: "a", passed: true })],
      mkSummary({
        accuracy: 1,
        totals: { questions: 1, passed: 1, failed: 0 },
      }),
    );
    expect(md).toContain("Accuracy**: 1 / 1");
    expect(md).toContain("100.0%");
    expect(md).toContain("`claude-sonnet-4-6`");
  });

  it("returns a 🎉 message when every question passed", () => {
    const md = buildFailureReport(
      [
        mkResult({ taskId: "a", passed: true }),
        mkResult({ taskId: "b", passed: true }),
      ],
      mkSummary({ accuracy: 1 }),
    );
    expect(md).toContain("All questions passed");
    expect(md).not.toMatch(/^## /m);
  });

  it("groups failures by tag and sorts by descending count", () => {
    const failures: QuestionResult[] = [
      mkResult({ taskId: "a", failureTags: ["no_tool_calls"] as FailureTag[] }),
      mkResult({ taskId: "b", failureTags: ["no_tool_calls"] as FailureTag[] }),
      mkResult({ taskId: "c", failureTags: ["no_tool_calls"] as FailureTag[] }),
      mkResult({ taskId: "d", failureTags: ["tool_error"] as FailureTag[] }),
    ];
    const md = buildFailureReport(failures, mkSummary());
    // no_tool_calls(3 个)应排在 tool_error(1 个)之前
    const noToolIdx = md.indexOf("## no_tool_calls");
    const toolErrIdx = md.indexOf("## tool_error");
    expect(noToolIdx).toBeGreaterThan(0);
    expect(toolErrIdx).toBeGreaterThan(noToolIdx);
  });

  it("includes up to 3 example task ids per tag", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) =>
      mkResult({ taskId: id, failureTags: ["no_tool_calls"] as FailureTag[] }),
    );
    const md = buildFailureReport(five, mkSummary());
    // 前三个应被引用;第四、第五个不应出现。
    expect(md).toContain("`a`");
    expect(md).toContain("`b`");
    expect(md).toContain("`c`");
    expect(md).not.toContain("`d`");
  });

  it("attaches the documented description for each tag", () => {
    const md = buildFailureReport(
      [mkResult({ taskId: "a", failureTags: ["timeout"] as FailureTag[] })],
      mkSummary(),
    );
    expect(md).toContain("Per-question timeout");
  });

  it("renders one heading per tag (multi-tagged failures appear under each)", () => {
    const md = buildFailureReport(
      [
        mkResult({
          taskId: "a",
          failureTags: ["no_tool_calls", "context_overflow"] as FailureTag[],
        }),
      ],
      mkSummary(),
    );
    expect(md).toContain("## no_tool_calls");
    expect(md).toContain("## context_overflow");
  });
});

// ─── buildToolStats 构建工具统计 ──────────────────────────────────────────────

describe("buildToolStats", () => {
  it("aggregates calls, errors, and durations across results", () => {
    const stats = buildToolStats([
      mkResult({
        taskId: "a",
        toolCalls: [
          { name: "webFetch", args: {}, durationMs: 1000 },
          { name: "webFetch", args: {}, durationMs: 3000 },
          {
            name: "webFetch",
            args: {},
            durationMs: 2000,
            error: "timeout",
          },
        ],
      }),
      mkResult({
        taskId: "b",
        toolCalls: [{ name: "readFile", args: {}, durationMs: 50 }],
      }),
    ]);
    const webFetch = stats.find((s) => s.name === "webFetch");
    expect(webFetch?.calls).toBe(3);
    expect(webFetch?.errors).toBe(1);
    expect(webFetch?.durations).toEqual([1000, 3000, 2000]);
  });

  it("returns tools sorted by descending call count", () => {
    const stats = buildToolStats([
      mkResult({
        taskId: "a",
        toolCalls: [
          { name: "rare", args: {}, durationMs: 1 },
          { name: "common", args: {}, durationMs: 1 },
          { name: "common", args: {}, durationMs: 1 },
        ],
      }),
    ]);
    expect(stats.map((s) => s.name)).toEqual(["common", "rare"]);
  });

  it("returns empty array when no tool calls exist", () => {
    expect(buildToolStats([])).toEqual([]);
    expect(buildToolStats([mkResult({ taskId: "a" })])).toEqual([]);
  });
});

// ─── buildToolUsageReport 构建工具使用报告 ────────────────────────────────────────────

describe("buildToolUsageReport", () => {
  it("renders a 'no tool calls' message when stats are empty", () => {
    const md = buildToolUsageReport([], mkSummary());
    expect(md).toContain("No tool calls");
  });

  it("renders a Markdown table with one row per tool", () => {
    const md = buildToolUsageReport(
      [
        mkResult({
          taskId: "a",
          toolCalls: [
            { name: "webFetch", args: {}, durationMs: 1000 },
            {
              name: "webFetch",
              args: {},
              durationMs: 2000,
              error: "boom",
            },
          ],
        }),
      ],
      mkSummary(),
    );
    expect(md).toContain("| Tool | Calls |");
    expect(md).toContain("`webFetch`");
    expect(md).toContain("50.0%"); // 1 个错误 / 2 次调用
  });
});
