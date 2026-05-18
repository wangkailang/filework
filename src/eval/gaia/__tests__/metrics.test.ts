import { describe, expect, it } from "vitest";

import {
  computeQualityMetrics,
  diffQualityMetrics,
  renderQualityDeltaTable,
} from "../metrics";
import type { QuestionResult, ToolCallRecord } from "../types";

// ─── Result factories ────────────────────────────────────────────────

const mkTc = (name: string, args: unknown = {}): ToolCallRecord => ({
  name,
  args,
  durationMs: 100,
});

const mkResult = (overrides: Partial<QuestionResult> = {}): QuestionResult => ({
  taskId: "task",
  level: 1,
  question: "?",
  attachment: null,
  groundTruth: "truth",
  predicted: "truth",
  passed: true,
  normalized: { groundTruth: "truth", predicted: "truth" },
  durationMs: 1000,
  toolCalls: [],
  stepCount: 1,
  reflectionFired: false,
  failureTags: [],
  eventsPath: "",
  ...overrides,
});

// ─── computeQualityMetrics ───────────────────────────────────────────

describe("computeQualityMetrics", () => {
  it("returns nullable fields when the set is empty", () => {
    const m = computeQualityMetrics([]);
    expect(m.medianStepsToCorrect).toBeNull();
    expect(m.medianStepsToFail).toBeNull();
    expect(m.toolRedundancyRate).toBeNull();
    expect(m.reflectionFireRate).toBe(0);
    expect(m.reflectionPassRate).toBeNull();
    expect(m.noReflectionPassRate).toBeNull();
  });

  it("computes median steps separately for passed and failed", () => {
    const m = computeQualityMetrics([
      mkResult({ passed: true, stepCount: 3 }),
      mkResult({ passed: true, stepCount: 5 }),
      mkResult({ passed: true, stepCount: 7 }),
      mkResult({ passed: false, stepCount: 12 }),
      mkResult({ passed: false, stepCount: 10 }),
    ]);
    expect(m.medianStepsToCorrect).toBe(5);
    expect(m.medianStepsToFail).toBe(11);
  });

  it("counts a tool call as redundant when same name+args repeats in same task", () => {
    const m = computeQualityMetrics([
      mkResult({
        toolCalls: [
          mkTc("webFetch", { url: "https://a.com" }),
          mkTc("webFetch", { url: "https://a.com" }),
          mkTc("webFetch", { url: "https://b.com" }),
        ],
      }),
    ]);
    expect(m.toolRedundancyRate).toBeCloseTo(1 / 3);
  });

  it("hashes args independent of key order (stable stringify)", () => {
    const m = computeQualityMetrics([
      mkResult({
        toolCalls: [
          mkTc("webFetch", { url: "x", method: "GET" }),
          mkTc("webFetch", { method: "GET", url: "x" }),
        ],
      }),
    ]);
    expect(m.toolRedundancyRate).toBeCloseTo(0.5);
  });

  it("does not count same args across different tasks as redundant", () => {
    const m = computeQualityMetrics([
      mkResult({ taskId: "a", toolCalls: [mkTc("webFetch", { url: "x" })] }),
      mkResult({ taskId: "b", toolCalls: [mkTc("webFetch", { url: "x" })] }),
    ]);
    expect(m.toolRedundancyRate).toBe(0);
  });

  it("computes reflection fire rate + conditional pass rates", () => {
    const m = computeQualityMetrics([
      mkResult({ reflectionFired: true, passed: true }),
      mkResult({ reflectionFired: true, passed: false }),
      mkResult({ reflectionFired: false, passed: true }),
      mkResult({ reflectionFired: false, passed: true }),
      mkResult({ reflectionFired: false, passed: false }),
    ]);
    expect(m.reflectionFireRate).toBeCloseTo(2 / 5);
    expect(m.reflectionPassRate).toBeCloseTo(1 / 2);
    expect(m.noReflectionPassRate).toBeCloseTo(2 / 3);
  });

  it("returns null for conditional pass rates when subset is empty", () => {
    const allReflected = computeQualityMetrics([
      mkResult({ reflectionFired: true, passed: true }),
    ]);
    expect(allReflected.noReflectionPassRate).toBeNull();

    const noneReflected = computeQualityMetrics([
      mkResult({ reflectionFired: false, passed: false }),
    ]);
    expect(noneReflected.reflectionPassRate).toBeNull();
  });
});

// ─── diffQualityMetrics ──────────────────────────────────────────────

describe("diffQualityMetrics", () => {
  it("returns empty when either side is undefined", () => {
    const m = computeQualityMetrics([mkResult({ passed: true, stepCount: 3 })]);
    expect(diffQualityMetrics(undefined, m)).toEqual([]);
    expect(diffQualityMetrics(m, undefined)).toEqual([]);
  });

  it("computes per-metric deltas", () => {
    const baseline = computeQualityMetrics([
      mkResult({ passed: true, stepCount: 3 }),
      mkResult({ passed: false, stepCount: 10 }),
    ]);
    const current = computeQualityMetrics([
      mkResult({ passed: true, stepCount: 5 }),
      mkResult({ passed: false, stepCount: 12 }),
    ]);
    const deltas = diffQualityMetrics(baseline, current);
    const stepsCorrect = deltas.find(
      (d) => d.metric === "medianStepsToCorrect",
    );
    expect(stepsCorrect?.delta).toBe(2);
  });

  it("returns null delta when either side is null", () => {
    const baseline = computeQualityMetrics([
      mkResult({ passed: true, stepCount: 3 }),
    ]);
    const current = computeQualityMetrics([
      mkResult({ passed: false, stepCount: 10 }),
    ]);
    const deltas = diffQualityMetrics(baseline, current);
    const stepsCorrect = deltas.find(
      (d) => d.metric === "medianStepsToCorrect",
    );
    expect(stepsCorrect?.baseline).toBe(3);
    expect(stepsCorrect?.current).toBeNull();
    expect(stepsCorrect?.delta).toBeNull();
  });
});

// ─── renderQualityDeltaTable ─────────────────────────────────────────

describe("renderQualityDeltaTable", () => {
  it("returns empty string for empty input", () => {
    expect(renderQualityDeltaTable([])).toBe("");
  });

  it("renders step metrics as integers and rates as percentages", () => {
    const baseline = computeQualityMetrics([
      mkResult({ passed: true, stepCount: 3, reflectionFired: false }),
      mkResult({ passed: false, stepCount: 10, reflectionFired: true }),
    ]);
    const current = computeQualityMetrics([
      mkResult({ passed: true, stepCount: 5, reflectionFired: true }),
      mkResult({ passed: false, stepCount: 12, reflectionFired: true }),
    ]);
    const out = renderQualityDeltaTable(diffQualityMetrics(baseline, current));
    expect(out).toMatch(/Median steps \(passed\) \| 3 \| 5 \| \+2/);
    expect(out).toMatch(
      /Reflection fire rate \| 50\.0% \| 100\.0% \| \+50\.0 pp/,
    );
  });
});
