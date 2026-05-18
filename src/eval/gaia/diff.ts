/**
 * Cross-run diff for the GAIA harness.
 *
 * Loads two run output directories (each produced by `runGaia`),
 * computes deltas, and renders a Markdown report. The intended
 * workflow:
 *
 *   1. Run `pnpm gaia-eval` once to establish a baseline.
 *   2. Land a PR that should move the needle (new tool, better
 *      reflection prompt, …).
 *   3. Run `pnpm gaia-eval` again into a new output dir.
 *   4. Run `pnpm gaia-eval-diff <baseline> <new>` — get a Markdown
 *      summary of what changed, which questions newly pass, which
 *      regressed, and how the failure-tag histogram shifted.
 *
 * Diff loading is best-effort: questions present in one run but not
 * the other are tagged separately, so reruns with different `--limit`
 * or `--level` filters degrade gracefully instead of crashing.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  diffQualityMetrics,
  type QualityMetricsDelta,
  renderQualityDeltaTable,
} from "./metrics";
import { formatCost } from "./pricing";
import type { FailureTag, QuestionResult, RunSummary } from "./types";

// ─── Loading ─────────────────────────────────────────────────────────

export interface LoadedRun {
  /** Absolute path to the run directory. */
  dir: string;
  summary: RunSummary;
  results: QuestionResult[];
  /** Quick lookup `taskId → result`. */
  byTaskId: Map<string, QuestionResult>;
}

const readJson = async <T>(p: string): Promise<T> =>
  JSON.parse(await readFile(p, "utf-8")) as T;

export const loadRun = async (dir: string): Promise<LoadedRun> => {
  const summary = await readJson<RunSummary>(path.join(dir, "summary.json"));
  const perDir = path.join(dir, "per-question");
  let entries: string[];
  try {
    entries = await readdir(perDir);
  } catch {
    entries = [];
  }
  const results: QuestionResult[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const r = await readJson<QuestionResult>(path.join(perDir, name));
    results.push(r);
  }
  const byTaskId = new Map(results.map((r) => [r.taskId, r]));
  return { dir, summary, results, byTaskId };
};

// ─── Diff computation ────────────────────────────────────────────────

export interface ChangedQuestion {
  taskId: string;
  level: number;
  question: string;
  baselineState: "passed" | "failed" | "missing";
  currentState: "passed" | "failed" | "missing";
  baselineTags?: FailureTag[];
  currentTags?: FailureTag[];
  baselinePredicted?: string | null;
  currentPredicted?: string | null;
  groundTruth?: string;
}

export interface FailureTagDelta {
  tag: FailureTag;
  baseline: number;
  current: number;
  delta: number;
}

export interface RunDiff {
  baselineDir: string;
  currentDir: string;
  baselineSummary: RunSummary;
  currentSummary: RunSummary;
  accuracyDelta: number;
  byLevelDelta: Record<
    string,
    { baseline: number; current: number; delta: number }
  >;
  costDeltaUsd: number | null;
  medianDurationDeltaMs: number;
  /** Failed in baseline, passed in current. */
  newlyPassed: ChangedQuestion[];
  /** Passed in baseline, failed in current — the regressions to investigate. */
  regressions: ChangedQuestion[];
  /** In baseline but not current (skipped via --limit or --level change). */
  removed: ChangedQuestion[];
  /** In current but not baseline. */
  added: ChangedQuestion[];
  failureTagDeltas: FailureTagDelta[];
  /** Per-metric deltas of trajectory quality. Empty when either side lacks `quality`. */
  qualityDeltas: QualityMetricsDelta[];
}

const countFailureTags = (
  results: readonly QuestionResult[],
): Map<FailureTag, number> => {
  const out = new Map<FailureTag, number>();
  for (const r of results) {
    for (const tag of r.failureTags) {
      out.set(tag, (out.get(tag) ?? 0) + 1);
    }
  }
  return out;
};

const toChangedQuestion = (
  taskId: string,
  baseline: QuestionResult | undefined,
  current: QuestionResult | undefined,
): ChangedQuestion => ({
  taskId,
  level: (current ?? baseline)?.level ?? 0,
  question: (current ?? baseline)?.question ?? "",
  baselineState: baseline ? (baseline.passed ? "passed" : "failed") : "missing",
  currentState: current ? (current.passed ? "passed" : "failed") : "missing",
  baselineTags: baseline?.failureTags,
  currentTags: current?.failureTags,
  baselinePredicted: baseline?.predicted ?? undefined,
  currentPredicted: current?.predicted ?? undefined,
  groundTruth: (current ?? baseline)?.groundTruth,
});

export const computeDiff = (
  baseline: LoadedRun,
  current: LoadedRun,
): RunDiff => {
  const allIds = new Set<string>([
    ...baseline.byTaskId.keys(),
    ...current.byTaskId.keys(),
  ]);

  const newlyPassed: ChangedQuestion[] = [];
  const regressions: ChangedQuestion[] = [];
  const removed: ChangedQuestion[] = [];
  const added: ChangedQuestion[] = [];

  for (const id of allIds) {
    const b = baseline.byTaskId.get(id);
    const c = current.byTaskId.get(id);
    if (b && !c) {
      removed.push(toChangedQuestion(id, b, undefined));
      continue;
    }
    if (!b && c) {
      added.push(toChangedQuestion(id, undefined, c));
      continue;
    }
    if (!b || !c) continue;
    if (!b.passed && c.passed) {
      newlyPassed.push(toChangedQuestion(id, b, c));
    } else if (b.passed && !c.passed) {
      regressions.push(toChangedQuestion(id, b, c));
    }
  }

  const baselineTags = countFailureTags(baseline.results);
  const currentTags = countFailureTags(current.results);
  const tagKeys = new Set<FailureTag>([
    ...baselineTags.keys(),
    ...currentTags.keys(),
  ]);
  const failureTagDeltas: FailureTagDelta[] = [];
  for (const tag of tagKeys) {
    const b = baselineTags.get(tag) ?? 0;
    const c = currentTags.get(tag) ?? 0;
    failureTagDeltas.push({ tag, baseline: b, current: c, delta: c - b });
  }
  failureTagDeltas.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current,
  );

  const byLevelDelta: RunDiff["byLevelDelta"] = {};
  const levels = new Set([
    ...Object.keys(baseline.summary.byLevel),
    ...Object.keys(current.summary.byLevel),
  ]);
  for (const lvl of levels) {
    const b = baseline.summary.byLevel[lvl]?.accuracy ?? 0;
    const c = current.summary.byLevel[lvl]?.accuracy ?? 0;
    byLevelDelta[lvl] = { baseline: b, current: c, delta: c - b };
  }

  const costDeltaUsd =
    current.summary.cost.totalUsd === 0 && baseline.summary.cost.totalUsd === 0
      ? null
      : current.summary.cost.totalUsd - baseline.summary.cost.totalUsd;

  return {
    baselineDir: baseline.dir,
    currentDir: current.dir,
    baselineSummary: baseline.summary,
    currentSummary: current.summary,
    accuracyDelta: current.summary.accuracy - baseline.summary.accuracy,
    byLevelDelta,
    costDeltaUsd,
    medianDurationDeltaMs:
      current.summary.duration.medianMs - baseline.summary.duration.medianMs,
    newlyPassed,
    regressions,
    removed,
    added,
    failureTagDeltas,
    qualityDeltas: diffQualityMetrics(
      baseline.summary.quality,
      current.summary.quality,
    ),
  };
};

// ─── Markdown rendering ──────────────────────────────────────────────

const signedPct = (n: number): string => {
  const pp = n * 100;
  if (Math.abs(pp) < 0.05) return "±0.0 pp";
  return `${pp > 0 ? "+" : ""}${pp.toFixed(1)} pp`;
};

const signedMs = (n: number): string => {
  if (Math.abs(n) < 50) return "±0";
  const seconds = n / 1000;
  return `${seconds > 0 ? "+" : ""}${seconds.toFixed(1)}s`;
};

const signedCost = (n: number | null): string => {
  if (n === null) return "—";
  if (Math.abs(n) < 0.005) return "±$0.00";
  return `${n > 0 ? "+" : "-"}${formatCost(Math.abs(n))}`;
};

const truncate = (s: string, max = 80): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const renderQuestionList = (
  qs: readonly ChangedQuestion[],
  emoji: string,
): string[] => {
  if (qs.length === 0) return [];
  const out: string[] = [];
  for (const q of qs.slice(0, 25)) {
    const before = q.baselineTags?.length
      ? ` (was: ${q.baselineTags.join(", ")})`
      : "";
    const now = q.currentTags?.length
      ? ` (now: ${q.currentTags.join(", ")})`
      : "";
    const predBefore =
      q.baselinePredicted !== undefined
        ? `predicted: ${truncate(JSON.stringify(q.baselinePredicted), 40)}`
        : "";
    const predNow =
      q.currentPredicted !== undefined
        ? `predicted: ${truncate(JSON.stringify(q.currentPredicted), 40)}`
        : "";
    const truth =
      q.groundTruth !== undefined
        ? ` · truth: ${truncate(JSON.stringify(q.groundTruth), 40)}`
        : "";
    out.push(
      `- ${emoji} \`${q.taskId.slice(0, 8)}\` (L${q.level}) ${before || now}${truth}`,
    );
    if (predBefore || predNow) {
      const parts = [predBefore, predNow].filter(Boolean).join(" → ");
      out.push(`  ${parts}`);
    }
  }
  if (qs.length > 25) out.push(`- … and ${qs.length - 25} more`);
  return out;
};

export const formatDiffMarkdown = (diff: RunDiff): string => {
  const lines: string[] = [];
  const b = diff.baselineSummary;
  const c = diff.currentSummary;
  lines.push(
    `# GAIA diff: ${b.config.startedAt.slice(0, 10)} → ${c.config.startedAt.slice(0, 10)}`,
  );
  lines.push("");
  lines.push(`- Baseline: \`${diff.baselineDir}\`  (\`${b.config.model}\`)`);
  lines.push(`- Current:  \`${diff.currentDir}\`  (\`${c.config.model}\`)`);
  lines.push("");

  // Top-level table.
  lines.push("## Top-level");
  lines.push("");
  lines.push("| Metric | Baseline | Current | Δ |");
  lines.push("|---|---:|---:|---:|");
  lines.push(
    `| Accuracy | ${(b.accuracy * 100).toFixed(1)}% | ${(c.accuracy * 100).toFixed(1)}% | **${signedPct(diff.accuracyDelta)}** |`,
  );
  for (const [lvl, d] of Object.entries(diff.byLevelDelta)) {
    lines.push(
      `| L${lvl} accuracy | ${(d.baseline * 100).toFixed(1)}% | ${(d.current * 100).toFixed(1)}% | ${signedPct(d.delta)} |`,
    );
  }
  lines.push(
    `| Total cost | ${formatCost(b.cost.totalUsd)} | ${formatCost(c.cost.totalUsd)} | ${signedCost(diff.costDeltaUsd)} |`,
  );
  lines.push(
    `| Median duration | ${(b.duration.medianMs / 1000).toFixed(1)}s | ${(c.duration.medianMs / 1000).toFixed(1)}s | ${signedMs(diff.medianDurationDeltaMs)} |`,
  );
  lines.push("");

  // Newly passed.
  if (diff.newlyPassed.length > 0) {
    lines.push(`## Newly passed (${diff.newlyPassed.length})`);
    lines.push("");
    lines.push(...renderQuestionList(diff.newlyPassed, "✓"));
    lines.push("");
  }

  // Regressions — emphasised because they're the alarm signal.
  if (diff.regressions.length > 0) {
    lines.push(`## ⚠️ Regressions (${diff.regressions.length})`);
    lines.push("");
    lines.push(
      "Questions that passed in baseline but fail now. Triage these first.",
    );
    lines.push("");
    lines.push(...renderQuestionList(diff.regressions, "✗"));
    lines.push("");
  } else {
    lines.push("## Regressions");
    lines.push("");
    lines.push("None — no questions went from pass to fail.");
    lines.push("");
  }

  // Added/removed (coverage drift).
  if (diff.added.length > 0 || diff.removed.length > 0) {
    lines.push(`## Coverage drift`);
    lines.push("");
    if (diff.added.length > 0) {
      lines.push(
        `Added (${diff.added.length}) — present in current but not baseline:`,
      );
      lines.push(...renderQuestionList(diff.added, "+"));
      lines.push("");
    }
    if (diff.removed.length > 0) {
      lines.push(
        `Removed (${diff.removed.length}) — present in baseline but not current:`,
      );
      lines.push(...renderQuestionList(diff.removed, "−"));
      lines.push("");
    }
  }

  // Failure tag deltas.
  if (diff.failureTagDeltas.length > 0) {
    lines.push("## Failure tag deltas");
    lines.push("");
    lines.push("| Tag | Baseline | Current | Δ |");
    lines.push("|---|---:|---:|---:|");
    for (const d of diff.failureTagDeltas) {
      const sign = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      lines.push(`| \`${d.tag}\` | ${d.baseline} | ${d.current} | ${sign} |`);
    }
    lines.push("");
  }

  // Trajectory quality deltas.
  if (diff.qualityDeltas.length > 0) {
    lines.push("## Trajectory quality");
    lines.push("");
    lines.push(renderQualityDeltaTable(diff.qualityDeltas));
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
};
