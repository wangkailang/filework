/**
 * Trajectory quality metrics aggregated across a GAIA run.
 *
 * These sit alongside accuracy/cost in `RunSummary`. They answer
 * questions that pass-rate alone can't:
 *
 *   - "Reflection-gate is on. Is it actually helping?"
 *       → `reflectionFireRate` + `reflectionPassRate` vs `noReflectionPassRate`
 *   - "Did we get more efficient or more wasteful with steps?"
 *       → `medianStepsToCorrect` over time
 *   - "Is the agent thrashing on the same tool call?"
 *       → `toolRedundancyRate`
 *
 * Pure module: takes the per-question results and returns metrics. No
 * I/O. Lives outside `runner.ts` so the diff CLI and any future
 * consumer can compute the same numbers from a loaded run.
 */

import { createHash } from "node:crypto";

import { median } from "./scorer";
import type { QuestionResult } from "./types";

export interface QualityMetrics {
  /** Median `stepCount` among passed tasks. `null` when none passed. */
  medianStepsToCorrect: number | null;
  /** Median `stepCount` among failed tasks. `null` when none failed. */
  medianStepsToFail: number | null;
  /**
   * Fraction in [0,1] of tool calls that exactly repeat a prior call
   * (same name + stable-stringified args) within the same task. `null`
   * when there were no tool calls at all across the run.
   */
  toolRedundancyRate: number | null;
  /** Fraction in [0,1] of tasks where the reflection-gate fired at least once. */
  reflectionFireRate: number;
  /** Pass rate among tasks where reflection fired. `null` when none fired. */
  reflectionPassRate: number | null;
  /** Pass rate among tasks where reflection did NOT fire. `null` when all fired. */
  noReflectionPassRate: number | null;
}

// ─── Stable args hash (mirrors replay.ts) ────────────────────────────

/**
 * Local copy of replay.ts's stable-stringify so metrics.ts stays
 * independent. If a third caller appears, extract to a shared util.
 */
const stableStringify = (value: unknown): string => {
  const seen = new WeakSet();
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[Circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(visit);
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, val]) => [k, visit(val)]));
  };
  return JSON.stringify(visit(value));
};

const argsHash = (name: string, args: unknown): string =>
  createHash("sha256")
    .update(`${name}::${stableStringify(args)}`)
    .digest("hex")
    .slice(0, 16);

// ─── Metric computations ─────────────────────────────────────────────

const computeRedundancyRate = (
  results: readonly QuestionResult[],
): number | null => {
  let totalCalls = 0;
  let repeats = 0;
  for (const r of results) {
    const seen = new Set<string>();
    for (const tc of r.toolCalls) {
      totalCalls += 1;
      const h = argsHash(tc.name, tc.args);
      if (seen.has(h)) repeats += 1;
      else seen.add(h);
    }
  }
  if (totalCalls === 0) return null;
  return repeats / totalCalls;
};

export const computeQualityMetrics = (
  results: readonly QuestionResult[],
): QualityMetrics => {
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);
  const reflected = results.filter((r) => r.reflectionFired);
  const notReflected = results.filter((r) => !r.reflectionFired);

  const stepsCorrect = passed.map((r) => r.stepCount);
  const stepsFail = failed.map((r) => r.stepCount);

  const reflectionFireRate =
    results.length === 0 ? 0 : reflected.length / results.length;
  const reflectionPassRate =
    reflected.length === 0
      ? null
      : reflected.filter((r) => r.passed).length / reflected.length;
  const noReflectionPassRate =
    notReflected.length === 0
      ? null
      : notReflected.filter((r) => r.passed).length / notReflected.length;

  return {
    medianStepsToCorrect:
      stepsCorrect.length === 0 ? null : median(stepsCorrect),
    medianStepsToFail: stepsFail.length === 0 ? null : median(stepsFail),
    toolRedundancyRate: computeRedundancyRate(results),
    reflectionFireRate,
    reflectionPassRate,
    noReflectionPassRate,
  };
};

// ─── Markdown rendering helpers ──────────────────────────────────────

const fmtPct = (v: number | null): string =>
  v === null ? "—" : `${(v * 100).toFixed(1)}%`;

const fmtNum = (v: number | null): string =>
  v === null ? "—" : String(Math.round(v));

const signedPct = (v: number): string => {
  const pp = v * 100;
  if (Math.abs(pp) < 0.05) return "±0.0 pp";
  return `${pp > 0 ? "+" : ""}${pp.toFixed(1)} pp`;
};

const signedInt = (v: number): string => {
  if (v === 0) return "±0";
  return v > 0 ? `+${v}` : `${v}`;
};

export interface QualityMetricsDelta {
  metric: keyof QualityMetrics;
  baseline: number | null;
  current: number | null;
  /** `null` when either side is `null` (no comparable baseline). */
  delta: number | null;
}

export const diffQualityMetrics = (
  baseline: QualityMetrics | undefined,
  current: QualityMetrics | undefined,
): QualityMetricsDelta[] => {
  if (!baseline || !current) return [];
  const keys: (keyof QualityMetrics)[] = [
    "medianStepsToCorrect",
    "medianStepsToFail",
    "toolRedundancyRate",
    "reflectionFireRate",
    "reflectionPassRate",
    "noReflectionPassRate",
  ];
  return keys.map((k) => {
    const b = baseline[k];
    const c = current[k];
    const delta = b === null || c === null ? null : c - b;
    return { metric: k, baseline: b, current: c, delta };
  });
};

const PRETTY_LABEL: Record<keyof QualityMetrics, string> = {
  medianStepsToCorrect: "Median steps (passed)",
  medianStepsToFail: "Median steps (failed)",
  toolRedundancyRate: "Tool redundancy rate",
  reflectionFireRate: "Reflection fire rate",
  reflectionPassRate: "Pass rate when reflection fired",
  noReflectionPassRate: "Pass rate when reflection skipped",
};

const isStepMetric = (k: keyof QualityMetrics): boolean =>
  k === "medianStepsToCorrect" || k === "medianStepsToFail";

export const renderQualityDeltaTable = (
  deltas: readonly QualityMetricsDelta[],
): string => {
  if (deltas.length === 0) return "";
  const lines: string[] = [];
  lines.push("| Metric | Baseline | Current | Δ |");
  lines.push("|---|---:|---:|---:|");
  for (const d of deltas) {
    const stepLike = isStepMetric(d.metric);
    const b = stepLike ? fmtNum(d.baseline) : fmtPct(d.baseline);
    const c = stepLike ? fmtNum(d.current) : fmtPct(d.current);
    const dlt =
      d.delta === null
        ? "—"
        : stepLike
          ? signedInt(d.delta)
          : signedPct(d.delta);
    lines.push(`| ${PRETTY_LABEL[d.metric]} | ${b} | ${c} | ${dlt} |`);
  }
  return lines.join("\n");
};
