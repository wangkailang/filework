/**
 * 跨整个 GAIA 运行聚合的轨迹质量指标。
 *
 * 这些指标与 `RunSummary` 中的准确率/成本并列。它们回答了仅靠
 * 通过率无法回答的问题:
 *
 *   - "反思门控已开启。它真的有帮助吗?"
 *       → `reflectionFireRate` + `reflectionPassRate` vs `noReflectionPassRate`
 *   - "随着时间推移,我们在步数上变得更高效还是更浪费?"
 *       → `medianStepsToCorrect` 的变化趋势
 *   - "agent 是否在同一个工具调用上反复打转?"
 *       → `toolRedundancyRate`
 *
 * 纯模块:接收按题目划分的结果并返回指标。无 I/O。置于
 * `runner.ts` 之外,使 diff CLI 及未来任何消费方都能从已加载的
 * 运行数据计算出相同的数字。
 */

import { createHash } from "node:crypto";

import { median } from "./scorer";
import type { QuestionResult } from "./types";

export interface QualityMetrics {
  /** 通过的任务中 `stepCount` 的中位数。无任务通过时为 `null`。 */
  medianStepsToCorrect: number | null;
  /** 失败的任务中 `stepCount` 的中位数。无任务失败时为 `null`。 */
  medianStepsToFail: number | null;
  /**
   * [0,1] 区间内的比例:同一任务内精确重复了先前调用
   * (名称相同 + 稳定序列化后的参数相同)的工具调用占比。当整个
   * 运行中完全没有工具调用时为 `null`。
   */
  toolRedundancyRate: number | null;
  /** [0,1] 区间内的比例:反思门控至少触发一次的任务占比。 */
  reflectionFireRate: number;
  /** 反思已触发的任务中的通过率。无任务触发时为 `null`。 */
  reflectionPassRate: number | null;
  /** 反思未触发的任务中的通过率。全部任务都触发时为 `null`。 */
  noReflectionPassRate: number | null;
}

// ─── 稳定参数哈希(与 replay.ts 保持一致) ────────────────────────────

/**
 * replay.ts 中稳定序列化逻辑的本地副本,使 metrics.ts 保持独立。
 * 若出现第三处调用方,应抽取为共享工具函数。
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

// ─── 指标计算 ─────────────────────────────────────────────

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

// ─── Markdown 渲染辅助函数 ──────────────────────────────────────

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
  /** 任一侧为 `null` 时(无可比较的基线)该值为 `null`。 */
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
