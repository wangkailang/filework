/**
 * Trajectory replay (signature + diff) for the GAIA harness.
 *
 * Reads an `events/<task_id>.jsonl` (produced by `runGaia`) and reduces
 * the stream into a deterministic *signature*: an ordered tuple of
 * tool calls (name + stable hash of args), reflection verdicts, and the
 * terminal status. Same trajectory → same hash, independent of token
 * timings, retries, or message deltas.
 *
 * Use cases:
 *
 *   1. After tweaking agent-loop / reflection-gate / system prompt,
 *      compare two runs to answer "did the path actually change?"
 *      Without this, you can't separate LLM jitter from code regressions.
 *
 *   2. Cheap, LLM-free fixture tests: snapshot a known-good trajectory
 *      and assert future runs still produce the same signature for
 *      deterministic flows.
 *
 *   3. Drift triage on a real run pair — batch mode walks both
 *      `events/` directories and reports which tasks diverged.
 *
 * NOT in v1: re-executing agent-loop against recorded LLM responses.
 * That's v2 and needs a streamText shim. v1 is purely a reduction +
 * comparison of what was already recorded.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentEvent } from "../../main/core/agent/events";

// ─── Signature shape ─────────────────────────────────────────────────

export type ReflectionVerdictKind = "continue" | "retry" | "abort";

export interface SignedToolCall {
  /** 0-based position in the tool call sequence. */
  index: number;
  /** Turn the call happened in. */
  turnIndex: number;
  name: string;
  /** 16-char sha256 prefix of stable-stringified args. */
  argsHash: string;
  /** ≤80 char preview for human-readable reports. */
  argsPreview: string;
  success: boolean;
}

export interface TrajectorySignature {
  taskId: string;
  /** Top-level fingerprint: 16-char sha256 of (tool seq + verdicts + endStatus). */
  hash: string;
  totalTurns: number;
  toolCalls: SignedToolCall[];
  reflectionVerdicts: ReflectionVerdictKind[];
  endStatus: "completed" | "failed" | "cancelled" | null;
  /** Coarse signal — surfaces when the agent went silent vs verbose. */
  finalTextLength: number;
}

// ─── Stable stringify / hashing ──────────────────────────────────────

/**
 * Deterministic JSON.stringify — sorted keys, drops `undefined` fields,
 * replaces cycles with `"[Circular]"`. Used so `{a:1,b:2}` and
 * `{b:2,a:1}` produce identical hashes.
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

const sha16 = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

const previewArgs = (args: unknown, max = 80): string => {
  const s = stableStringify(args) ?? "null";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

// ─── Event stream loading ────────────────────────────────────────────

/** Parse a JSONL file into AgentEvents. Throws with line number on bad input. */
export const loadEventStream = async (
  filePath: string,
): Promise<AgentEvent[]> => {
  const raw = await readFile(filePath, "utf-8");
  const out: AgentEvent[] = [];
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AgentEvent);
    } catch (err) {
      throw new Error(
        `${filePath}:${lineNo}: invalid JSON — ${(err as Error).message}`,
      );
    }
  }
  return out;
};

// ─── Reduce events → signature ───────────────────────────────────────

export const computeSignature = (
  taskId: string,
  events: readonly AgentEvent[],
): TrajectorySignature => {
  const toolCalls: SignedToolCall[] = [];
  const reflectionVerdicts: ReflectionVerdictKind[] = [];
  let currentTurn = 0;
  let totalTurns = 0;
  let endStatus: TrajectorySignature["endStatus"] = null;
  let finalTextLength = 0;
  const startedById = new Map<string, { name: string; args: unknown }>();

  for (const e of events) {
    switch (e.type) {
      case "turn_start":
        currentTurn = e.turnIndex;
        totalTurns = Math.max(totalTurns, e.turnIndex + 1);
        break;
      case "tool_execution_start":
        startedById.set(e.toolCallId, { name: e.toolName, args: e.args });
        break;
      case "tool_execution_end": {
        const start = startedById.get(e.toolCallId);
        const argsForHash = start?.args ?? null;
        toolCalls.push({
          index: toolCalls.length,
          turnIndex: currentTurn,
          name: e.toolName,
          argsHash: sha16(stableStringify(argsForHash)),
          argsPreview: previewArgs(argsForHash),
          success: e.success,
        });
        startedById.delete(e.toolCallId);
        break;
      }
      case "reflection_verdict":
        reflectionVerdicts.push(e.verdict.kind);
        break;
      case "agent_end":
        endStatus = e.status;
        finalTextLength = e.finalText?.length ?? 0;
        break;
    }
  }

  const hashInput = JSON.stringify({
    tc: toolCalls.map((t) => [t.name, t.argsHash, t.success]),
    rv: reflectionVerdicts,
    end: endStatus,
  });

  return {
    taskId,
    hash: sha16(hashInput),
    totalTurns,
    toolCalls,
    reflectionVerdicts,
    endStatus,
    finalTextLength,
  };
};

// ─── Diff two signatures ─────────────────────────────────────────────

export type SequenceDiffOp =
  | {
      kind: "match";
      index: number;
      baseline: SignedToolCall;
      current: SignedToolCall;
    }
  | {
      kind: "args-changed";
      index: number;
      baseline: SignedToolCall;
      current: SignedToolCall;
    }
  | { kind: "added"; index: number; current: SignedToolCall }
  | { kind: "removed"; index: number; baseline: SignedToolCall };

export interface SignatureDiff {
  taskId: string;
  identical: boolean;
  baseline: TrajectorySignature;
  current: TrajectorySignature;
  /** Per-step alignment of tool sequences. */
  ops: SequenceDiffOp[];
  toolSequenceChanged: boolean;
  reflectionVerdictsChanged: boolean;
  endStatusChanged: boolean;
}

/**
 * Greedy aligned diff of tool call sequences.
 *
 * Matches by `name` left-to-right; equal names with differing `argsHash`
 * are tagged `args-changed` (same-step mutation). When names diverge,
 * looks ahead 3 steps to decide whether current has an insertion or
 * baseline has a deletion. Falls back to paired remove+add when neither
 * side reconverges within the window.
 *
 * Intentionally simpler than Myers — for typical trajectory drift (1–2
 * inserted/dropped calls) it produces clean diffs, and we surface
 * "trajectory changed" as a binary signal anyway.
 */
export const diffSignatures = (
  baseline: TrajectorySignature,
  current: TrajectorySignature,
): SignatureDiff => {
  const ops: SequenceDiffOp[] = [];
  const b = baseline.toolCalls;
  const c = current.toolCalls;
  const LOOKAHEAD = 3;
  let i = 0;
  let j = 0;

  while (i < b.length && j < c.length) {
    if (b[i].name === c[j].name) {
      if (b[i].argsHash === c[j].argsHash) {
        ops.push({
          kind: "match",
          index: ops.length,
          baseline: b[i],
          current: c[j],
        });
      } else {
        ops.push({
          kind: "args-changed",
          index: ops.length,
          baseline: b[i],
          current: c[j],
        });
      }
      i += 1;
      j += 1;
      continue;
    }
    const nextBInC = c
      .slice(j, j + LOOKAHEAD)
      .findIndex((t) => t.name === b[i].name);
    const nextCInB = b
      .slice(i, i + LOOKAHEAD)
      .findIndex((t) => t.name === c[j].name);
    if (nextBInC !== -1 && (nextCInB === -1 || nextBInC <= nextCInB)) {
      ops.push({ kind: "added", index: ops.length, current: c[j] });
      j += 1;
    } else if (nextCInB !== -1) {
      ops.push({ kind: "removed", index: ops.length, baseline: b[i] });
      i += 1;
    } else {
      ops.push({ kind: "removed", index: ops.length, baseline: b[i] });
      ops.push({ kind: "added", index: ops.length, current: c[j] });
      i += 1;
      j += 1;
    }
  }
  while (i < b.length) {
    ops.push({ kind: "removed", index: ops.length, baseline: b[i] });
    i += 1;
  }
  while (j < c.length) {
    ops.push({ kind: "added", index: ops.length, current: c[j] });
    j += 1;
  }

  const toolSequenceChanged = ops.some((o) => o.kind !== "match");
  const reflectionVerdictsChanged =
    JSON.stringify(baseline.reflectionVerdicts) !==
    JSON.stringify(current.reflectionVerdicts);
  const endStatusChanged = baseline.endStatus !== current.endStatus;
  const identical =
    baseline.hash === current.hash &&
    !toolSequenceChanged &&
    !reflectionVerdictsChanged &&
    !endStatusChanged;

  return {
    taskId: baseline.taskId,
    identical,
    baseline,
    current,
    ops,
    toolSequenceChanged,
    reflectionVerdictsChanged,
    endStatusChanged,
  };
};

// ─── Batch mode: walk two run dirs ───────────────────────────────────

export interface BatchReplayEntry {
  taskId: string;
  status:
    | "identical"
    | "changed"
    | "missing-in-baseline"
    | "missing-in-current"
    | "load-error";
  diff?: SignatureDiff;
  error?: string;
}

export interface BatchReplayReport {
  baselineDir: string;
  currentDir: string;
  total: number;
  identical: number;
  changed: number;
  missingInBaseline: number;
  missingInCurrent: number;
  errors: number;
  entries: BatchReplayEntry[];
}

const listEventFiles = async (runDir: string): Promise<Map<string, string>> => {
  const eventsDir = path.join(runDir, "events");
  let entries: string[];
  try {
    entries = await readdir(eventsDir);
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const taskId = name.replace(/\.jsonl$/, "");
    out.set(taskId, path.join(eventsDir, name));
  }
  return out;
};

export const runBatchReplay = async (
  baselineDir: string,
  currentDir: string,
): Promise<BatchReplayReport> => {
  const [baselineFiles, currentFiles] = await Promise.all([
    listEventFiles(baselineDir),
    listEventFiles(currentDir),
  ]);
  const allIds = new Set<string>([
    ...baselineFiles.keys(),
    ...currentFiles.keys(),
  ]);
  const entries: BatchReplayEntry[] = [];
  let identical = 0;
  let changed = 0;
  let missingInBaseline = 0;
  let missingInCurrent = 0;
  let errors = 0;

  for (const id of [...allIds].sort()) {
    const bPath = baselineFiles.get(id);
    const cPath = currentFiles.get(id);
    if (!bPath) {
      entries.push({ taskId: id, status: "missing-in-baseline" });
      missingInBaseline += 1;
      continue;
    }
    if (!cPath) {
      entries.push({ taskId: id, status: "missing-in-current" });
      missingInCurrent += 1;
      continue;
    }
    try {
      const [bEvents, cEvents] = await Promise.all([
        loadEventStream(bPath),
        loadEventStream(cPath),
      ]);
      const diff = diffSignatures(
        computeSignature(id, bEvents),
        computeSignature(id, cEvents),
      );
      if (diff.identical) {
        identical += 1;
        entries.push({ taskId: id, status: "identical", diff });
      } else {
        changed += 1;
        entries.push({ taskId: id, status: "changed", diff });
      }
    } catch (err) {
      errors += 1;
      entries.push({
        taskId: id,
        status: "load-error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    baselineDir,
    currentDir,
    total: allIds.size,
    identical,
    changed,
    missingInBaseline,
    missingInCurrent,
    errors,
    entries,
  };
};

// ─── Rendering ───────────────────────────────────────────────────────

const escapePipe = (s: string): string => s.replace(/\|/g, "\\|");

export const formatSignature = (sig: TrajectorySignature): string => {
  const lines: string[] = [];
  lines.push(`# Trajectory signature: \`${sig.taskId}\``);
  lines.push("");
  lines.push(`- Hash: \`${sig.hash}\``);
  lines.push(`- Turns: ${sig.totalTurns}`);
  lines.push(`- Tool calls: ${sig.toolCalls.length}`);
  lines.push(
    `- Reflections: ${
      sig.reflectionVerdicts.length > 0
        ? sig.reflectionVerdicts.join(" → ")
        : "—"
    }`,
  );
  lines.push(`- End status: ${sig.endStatus ?? "—"}`);
  lines.push(`- Final text length: ${sig.finalTextLength}`);
  lines.push("");
  if (sig.toolCalls.length > 0) {
    lines.push("## Tool sequence");
    lines.push("");
    lines.push("| # | Turn | Tool | OK | Args |");
    lines.push("|---:|---:|---|---|---|");
    for (const tc of sig.toolCalls) {
      lines.push(
        `| ${tc.index} | ${tc.turnIndex} | \`${tc.name}\` | ${tc.success ? "✓" : "✗"} | \`${escapePipe(tc.argsPreview)}\` |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
};

export const formatSignatureDiff = (diff: SignatureDiff): string => {
  const lines: string[] = [];
  lines.push(`# Trajectory diff: \`${diff.taskId}\``);
  lines.push("");
  lines.push(`- Baseline hash: \`${diff.baseline.hash}\``);
  lines.push(`- Current hash:  \`${diff.current.hash}\``);
  lines.push(`- Identical: ${diff.identical ? "yes" : "**no**"}`);
  lines.push("");
  if (diff.endStatusChanged) {
    lines.push(
      `⚠️ End status changed: \`${diff.baseline.endStatus ?? "—"}\` → \`${diff.current.endStatus ?? "—"}\``,
    );
    lines.push("");
  }
  if (diff.reflectionVerdictsChanged) {
    lines.push(
      `⚠️ Reflection verdicts: \`${
        diff.baseline.reflectionVerdicts.join(",") || "—"
      }\` → \`${diff.current.reflectionVerdicts.join(",") || "—"}\``,
    );
    lines.push("");
  }
  if (!diff.toolSequenceChanged) {
    lines.push("Tool sequence: identical.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("## Tool sequence diff");
  lines.push("");
  for (const op of diff.ops) {
    switch (op.kind) {
      case "match":
        lines.push(`  · \`${op.baseline.name}\` (T${op.baseline.turnIndex})`);
        break;
      case "args-changed":
        lines.push(
          `  ~ \`${op.baseline.name}\` args changed (T${op.baseline.turnIndex}→T${op.current.turnIndex}): \`${op.baseline.argsHash}\` → \`${op.current.argsHash}\``,
        );
        break;
      case "removed":
        lines.push(
          `  − \`${op.baseline.name}\` (T${op.baseline.turnIndex}) — only in baseline`,
        );
        break;
      case "added":
        lines.push(
          `  + \`${op.current.name}\` (T${op.current.turnIndex}) — only in current`,
        );
        break;
    }
  }
  lines.push("");
  return lines.join("\n");
};

export const formatBatchReport = (report: BatchReplayReport): string => {
  const lines: string[] = [];
  lines.push("# GAIA trajectory replay");
  lines.push("");
  lines.push(`- Baseline: \`${report.baselineDir}\``);
  lines.push(`- Current:  \`${report.currentDir}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|---|---:|");
  lines.push(`| Identical | ${report.identical} |`);
  lines.push(`| Changed | ${report.changed} |`);
  lines.push(`| Missing in baseline | ${report.missingInBaseline} |`);
  lines.push(`| Missing in current | ${report.missingInCurrent} |`);
  lines.push(`| Load errors | ${report.errors} |`);
  lines.push(`| **Total** | **${report.total}** |`);
  lines.push("");

  const changedEntries = report.entries.filter((e) => e.status === "changed");
  if (changedEntries.length > 0) {
    lines.push(`## Changed trajectories (${changedEntries.length})`);
    lines.push("");
    lines.push("| Task | Tool seq | Reflections | End status |");
    lines.push("|---|---|---|---|");
    for (const entry of changedEntries) {
      const d = entry.diff;
      if (!d) continue;
      const seqMark = d.toolSequenceChanged ? "Δ" : "·";
      const refMark = d.reflectionVerdictsChanged
        ? `${d.baseline.reflectionVerdicts.join(",") || "—"} → ${d.current.reflectionVerdicts.join(",") || "—"}`
        : "·";
      const endMark = d.endStatusChanged
        ? `${d.baseline.endStatus ?? "—"} → ${d.current.endStatus ?? "—"}`
        : "·";
      lines.push(
        `| \`${entry.taskId.slice(0, 8)}\` | ${seqMark} | ${refMark} | ${endMark} |`,
      );
    }
    lines.push("");
    lines.push("### Per-task sequence diffs");
    lines.push("");
    const SHOW = 20;
    for (const entry of changedEntries.slice(0, SHOW)) {
      if (!entry.diff) continue;
      lines.push(`<details><summary><code>${entry.taskId}</code></summary>`);
      lines.push("");
      lines.push(formatSignatureDiff(entry.diff));
      lines.push("</details>");
      lines.push("");
    }
    if (changedEntries.length > SHOW) {
      lines.push(`_… and ${changedEntries.length - SHOW} more changed tasks._`);
      lines.push("");
    }
  }

  if (report.errors > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const entry of report.entries.filter(
      (e) => e.status === "load-error",
    )) {
      lines.push(`- \`${entry.taskId}\`: ${entry.error ?? ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
};
