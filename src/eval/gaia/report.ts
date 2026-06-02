/**
 * 与 summary.json 一同产出的人读 Markdown 报告。
 *
 * 两份报告 —— 都从内存中的 `QuestionResult[]` + `RunSummary` 渲染,
 * 因而能作为纯字符串构造器保持可测试:
 *
 *   - `failures.md`     —— 按标签分组的失败拆解,每个标签 3 个示例
 *                         题目,按频次排序。诊断优先:每个标签都有
 *                         一行说明,使审阅者能快速浏览文件并知道
 *                         该看哪里。
 *
 *   - `tool-usage.md`   —— 本次运行中触发过的每个工具的表格,含
 *                         调用次数、时长中位数和错误率。为下一轮
 *                         修复显现"哪个工具最不可靠"。
 */

import { formatCost } from "./pricing";
import type { FailureTag, QuestionResult, RunSummary } from "./types";

// ─── 失败报告 ──────────────────────────────────────────────────

const TAG_DESCRIPTIONS: Record<FailureTag, string> = {
  no_tool_calls:
    "Agent answered without invoking any tools — most likely hallucinated from training data. " +
    "Worth checking whether the system prompt is steering toward direct-answer too aggressively.",
  tool_error:
    "At least one tool call returned an error and the agent didn't recover. " +
    "Look at the failing tool's args and result in `per-question/<id>.json` → `toolCalls[]`.",
  context_overflow:
    "The agent ran out of step budget or context window. Either bump `maxStepsPerTurn` " +
    "or audit the compaction path for that question's chain.",
  attachment_not_processed:
    "The question has an attachment but no tool call referenced it. Usually means the " +
    "attachment format isn't covered by an available parser (audio/video/etc.).",
  wrong_answer_correct_path:
    "Tools fired correctly but the extracted final answer didn't match the ground truth. " +
    "Often a normalisation issue or an off-by-one extraction — compare `predicted` vs " +
    "`groundTruth` to triage.",
  reflection_not_fired:
    "Long tool chain (≥5 turns) with no `reflection_verdict` event. Reflection-gate " +
    "heuristic may need lowering for this question type.",
  timeout:
    "Per-question timeout hit (default 5min). Either the agent stalled or the workload " +
    "genuinely needs more time.",
  exception:
    "The runner itself threw. See `exception` field on the per-question JSON for the stack.",
};

const TAG_ORDER: FailureTag[] = [
  "no_tool_calls",
  "tool_error",
  "attachment_not_processed",
  "context_overflow",
  "reflection_not_fired",
  "wrong_answer_correct_path",
  "timeout",
  "exception",
];

const truncate = (s: string, max = 80): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const dollarBlurb = (s: RunSummary): string => {
  const totalUsd = s.cost.totalUsd > 0 ? formatCost(s.cost.totalUsd) : "—";
  return `**Cost**: ${totalUsd}`;
};

/**
 * 渲染 failures.md 正文。返回 Markdown 字符串(而非路径);
 * 由 runner 负责写入。纯函数 —— 可测试。
 */
export const buildFailureReport = (
  results: readonly QuestionResult[],
  summary: RunSummary,
): string => {
  const lines: string[] = [];
  const date = summary.config.startedAt.slice(0, 10);
  lines.push(`# GAIA run ${date} — failure breakdown`);
  lines.push("");
  lines.push(
    `**Accuracy**: ${summary.totals.passed} / ${summary.totals.questions} ` +
      `(${(summary.accuracy * 100).toFixed(1)}%)  ·  ${dollarBlurb(summary)}  ·  ` +
      `**Model**: \`${summary.config.model}\``,
  );
  lines.push("");

  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    lines.push("All questions passed. 🎉");
    return lines.join("\n");
  }

  const byTag = new Map<FailureTag, QuestionResult[]>();
  for (const r of failed) {
    for (const tag of r.failureTags) {
      const arr = byTag.get(tag) ?? [];
      arr.push(r);
      byTag.set(tag, arr);
    }
  }

  // 稳定排序:先按文档约定的顺序,再排其余未知标签。
  const knownInOrder = TAG_ORDER.filter((t) => byTag.has(t));
  const unknown = [...byTag.keys()].filter(
    (t) => !TAG_ORDER.includes(t),
  ) as FailureTag[];
  const sortedTags = [...knownInOrder, ...unknown].sort((a, b) => {
    const na = byTag.get(a)?.length ?? 0;
    const nb = byTag.get(b)?.length ?? 0;
    return nb - na;
  });

  for (const tag of sortedTags) {
    const qs = byTag.get(tag) ?? [];
    const pct = ((qs.length / failed.length) * 100).toFixed(0);
    lines.push(`## ${tag} (${qs.length} questions, ${pct}% of failures)`);
    lines.push("");
    lines.push(TAG_DESCRIPTIONS[tag] ?? "(no description)");
    lines.push("");
    lines.push("Examples:");
    for (const q of qs.slice(0, 3)) {
      const pred = q.predicted ?? "<no answer extracted>";
      const truth = q.groundTruth;
      lines.push(
        `- \`${q.taskId.slice(0, 8)}\` (L${q.level}) — ${q.toolCalls.length} tool calls · ` +
          `predicted: ${truncate(JSON.stringify(pred), 50)} · truth: ${truncate(JSON.stringify(truth), 50)}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
};

// ─── 工具使用报告 ───────────────────────────────────────────────

export interface ToolStats {
  name: string;
  calls: number;
  errors: number;
  durations: number[];
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

/**
 * 跨每道题目的 `toolCalls[]` 聚合各工具的统计数据。
 * 按调用次数降序返回。
 */
export const buildToolStats = (
  results: readonly QuestionResult[],
): ToolStats[] => {
  const byName = new Map<string, ToolStats>();
  for (const r of results) {
    for (const call of r.toolCalls) {
      let stats = byName.get(call.name);
      if (!stats) {
        stats = { name: call.name, calls: 0, errors: 0, durations: [] };
        byName.set(call.name, stats);
      }
      stats.calls += 1;
      if (call.error) stats.errors += 1;
      stats.durations.push(call.durationMs);
    }
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls);
};

export const buildToolUsageReport = (
  results: readonly QuestionResult[],
  summary: RunSummary,
): string => {
  const stats = buildToolStats(results);
  const lines: string[] = [];
  const date = summary.config.startedAt.slice(0, 10);
  lines.push(`# GAIA run ${date} — tool usage`);
  lines.push("");
  if (stats.length === 0) {
    lines.push("No tool calls in this run.");
    return lines.join("\n");
  }
  lines.push("| Tool | Calls | Median duration | Error rate |");
  lines.push("|---|---:|---:|---:|");
  for (const s of stats) {
    const errRate =
      s.calls > 0 ? `${((s.errors / s.calls) * 100).toFixed(1)}%` : "—";
    lines.push(
      `| \`${s.name}\` | ${s.calls} | ${formatDuration(median(s.durations))} | ${errRate} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * 将两份报告打包,使 runner 一次调用即可取得。
 */
export const renderReports = (
  results: readonly QuestionResult[],
  summary: RunSummary,
): { failures: string; toolUsage: string } => ({
  failures: buildFailureReport(results, summary),
  toolUsage: buildToolUsageReport(results, summary),
});

/** 测试接缝。 */
export const _internals = { TAG_DESCRIPTIONS, TAG_ORDER };
