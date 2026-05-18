import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../main/core/agent/events";
import {
  computeSignature,
  diffSignatures,
  loadEventStream,
  runBatchReplay,
} from "../replay";

// ─── Event factories ─────────────────────────────────────────────────

const turnStart = (turnIndex: number): AgentEvent => ({
  type: "turn_start",
  agentId: "a1",
  turnIndex,
});

const toolStart = (id: string, name: string, args: unknown): AgentEvent => ({
  type: "tool_execution_start",
  agentId: "a1",
  toolCallId: id,
  toolName: name,
  args,
});

const toolEnd = (
  id: string,
  name: string,
  opts: { success?: boolean } = {},
): AgentEvent => ({
  type: "tool_execution_end",
  agentId: "a1",
  toolCallId: id,
  toolName: name,
  result: opts.success === false ? "boom" : "ok",
  success: opts.success !== false,
  durationMs: 100,
});

const reflectionVerdict = (
  kind: "continue" | "retry" | "abort",
): AgentEvent => ({
  type: "reflection_verdict",
  agentId: "a1",
  attempt: 0,
  verdict:
    kind === "retry"
      ? { kind, feedback: "try again" }
      : kind === "abort"
        ? { kind, reason: "stuck" }
        : { kind },
});

const agentEnd = (
  status: "completed" | "failed" | "cancelled" = "completed",
  finalText = "FINAL ANSWER: 42",
): AgentEvent => ({
  type: "agent_end",
  agentId: "a1",
  status,
  finalText,
});

// ─── computeSignature ────────────────────────────────────────────────

describe("computeSignature", () => {
  it("hashes identical event streams identically", () => {
    const events: AgentEvent[] = [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "https://a.com" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ];
    const a = computeSignature("task", events);
    const b = computeSignature("task", events);
    expect(a.hash).toBe(b.hash);
    expect(a.toolCalls).toHaveLength(1);
    expect(a.toolCalls[0].name).toBe("webFetch");
    expect(a.endStatus).toBe("completed");
  });

  it("produces different hash when tool args differ", () => {
    const base = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "https://a.com" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ]);
    const changed = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "https://b.com" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ]);
    expect(base.hash).not.toBe(changed.hash);
  });

  it("ignores object key order in args (stable stringify)", () => {
    const a = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "https://a.com", method: "GET" }),
      toolEnd("t1", "webFetch"),
    ]);
    const b = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "webFetch", { method: "GET", url: "https://a.com" }),
      toolEnd("t1", "webFetch"),
    ]);
    expect(a.hash).toBe(b.hash);
    expect(a.toolCalls[0].argsHash).toBe(b.toolCalls[0].argsHash);
  });

  it("captures reflection verdicts in order", () => {
    const sig = computeSignature("task", [
      turnStart(0),
      reflectionVerdict("continue"),
      reflectionVerdict("retry"),
      agentEnd(),
    ]);
    expect(sig.reflectionVerdicts).toEqual(["continue", "retry"]);
  });

  it("captures end status and finalText length", () => {
    const sig = computeSignature("task", [
      agentEnd("cancelled", "FINAL ANSWER: unknown"),
    ]);
    expect(sig.endStatus).toBe("cancelled");
    expect(sig.finalTextLength).toBe("FINAL ANSWER: unknown".length);
  });

  it("handles empty event stream", () => {
    const sig = computeSignature("task", []);
    expect(sig.toolCalls).toHaveLength(0);
    expect(sig.reflectionVerdicts).toEqual([]);
    expect(sig.endStatus).toBeNull();
    expect(sig.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records tool failure in signature", () => {
    const sig = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch", { success: false }),
      agentEnd(),
    ]);
    expect(sig.toolCalls[0].success).toBe(false);

    const successSig = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ]);
    expect(sig.hash).not.toBe(successSig.hash);
  });

  it("tracks current turn for each tool call", () => {
    const sig = computeSignature("task", [
      turnStart(0),
      toolStart("t1", "a", null),
      toolEnd("t1", "a"),
      turnStart(1),
      toolStart("t2", "b", null),
      toolEnd("t2", "b"),
      agentEnd(),
    ]);
    expect(sig.toolCalls.map((t) => t.turnIndex)).toEqual([0, 1]);
    expect(sig.totalTurns).toBe(2);
  });
});

// ─── diffSignatures ──────────────────────────────────────────────────

const buildSig = (taskId: string, ...events: AgentEvent[]) =>
  computeSignature(taskId, events);

describe("diffSignatures", () => {
  it("identical when trajectories match", () => {
    const events: AgentEvent[] = [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ];
    const d = diffSignatures(
      computeSignature("task", events),
      computeSignature("task", events),
    );
    expect(d.identical).toBe(true);
    expect(d.ops.every((o) => o.kind === "match")).toBe(true);
  });

  it("detects added tool call", () => {
    const baseline = buildSig(
      "task",
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    );
    const current = buildSig(
      "task",
      turnStart(0),
      toolStart("t0", "webSearch", { query: "y" }),
      toolEnd("t0", "webSearch"),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    );
    const d = diffSignatures(baseline, current);
    expect(d.identical).toBe(false);
    expect(d.toolSequenceChanged).toBe(true);
    expect(d.ops.filter((o) => o.kind === "added")).toHaveLength(1);
    expect(d.ops.filter((o) => o.kind === "match")).toHaveLength(1);
  });

  it("detects removed tool call", () => {
    const baseline = buildSig(
      "task",
      turnStart(0),
      toolStart("t0", "webSearch", { query: "y" }),
      toolEnd("t0", "webSearch"),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
    );
    const current = buildSig(
      "task",
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
    );
    const d = diffSignatures(baseline, current);
    expect(d.ops.filter((o) => o.kind === "removed")).toHaveLength(1);
    expect(d.ops.filter((o) => o.kind === "match")).toHaveLength(1);
  });

  it("detects args-changed (same tool, different inputs)", () => {
    const baseline = buildSig(
      "task",
      turnStart(0),
      toolStart("t1", "webFetch", { url: "https://a.com" }),
      toolEnd("t1", "webFetch"),
    );
    const current = buildSig(
      "task",
      turnStart(0),
      toolStart("t1", "webFetch", { url: "https://b.com" }),
      toolEnd("t1", "webFetch"),
    );
    const d = diffSignatures(baseline, current);
    expect(d.ops.filter((o) => o.kind === "args-changed")).toHaveLength(1);
    expect(d.toolSequenceChanged).toBe(true);
  });

  it("detects reflection verdict changes", () => {
    const baseline = buildSig("task", turnStart(0), agentEnd());
    const current = buildSig(
      "task",
      turnStart(0),
      reflectionVerdict("retry"),
      agentEnd(),
    );
    const d = diffSignatures(baseline, current);
    expect(d.reflectionVerdictsChanged).toBe(true);
    expect(d.identical).toBe(false);
  });

  it("detects end status changes", () => {
    const baseline = buildSig("task", agentEnd("completed"));
    const current = buildSig("task", agentEnd("cancelled"));
    const d = diffSignatures(baseline, current);
    expect(d.endStatusChanged).toBe(true);
    expect(d.identical).toBe(false);
  });

  it("handles full replacement as paired remove+add", () => {
    const baseline = buildSig(
      "task",
      turnStart(0),
      toolStart("t1", "a", null),
      toolEnd("t1", "a"),
    );
    const current = buildSig(
      "task",
      turnStart(0),
      toolStart("t1", "b", null),
      toolEnd("t1", "b"),
    );
    const d = diffSignatures(baseline, current);
    expect(d.ops.filter((o) => o.kind === "removed")).toHaveLength(1);
    expect(d.ops.filter((o) => o.kind === "added")).toHaveLength(1);
  });
});

// ─── loadEventStream ─────────────────────────────────────────────────

describe("loadEventStream", () => {
  it("parses valid JSONL", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gaia-replay-"));
    const file = path.join(dir, "x.jsonl");
    const lines = [turnStart(0), agentEnd()]
      .map((e) => JSON.stringify(e))
      .join("\n");
    await writeFile(file, `${lines}\n`, "utf-8");
    const events = await loadEventStream(file);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("turn_start");
  });

  it("throws with line number on invalid JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gaia-replay-"));
    const file = path.join(dir, "bad.jsonl");
    await writeFile(
      file,
      `${JSON.stringify(turnStart(0))}\n{not json}\n`,
      "utf-8",
    );
    await expect(loadEventStream(file)).rejects.toThrow(/:2: invalid JSON/);
  });

  it("ignores blank lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gaia-replay-"));
    const file = path.join(dir, "blanks.jsonl");
    await writeFile(
      file,
      `${JSON.stringify(turnStart(0))}\n\n\n${JSON.stringify(agentEnd())}\n`,
      "utf-8",
    );
    const events = await loadEventStream(file);
    expect(events).toHaveLength(2);
  });
});

// ─── runBatchReplay (end-to-end with tmpdir) ─────────────────────────

describe("runBatchReplay", () => {
  const writeEventsFile = async (
    runDir: string,
    taskId: string,
    events: AgentEvent[],
  ): Promise<void> => {
    const eventsDir = path.join(runDir, "events");
    await mkdir(eventsDir, { recursive: true });
    const body = events.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path.join(eventsDir, `${taskId}.jsonl`), `${body}\n`);
  };

  it("classifies identical, changed, and missing tasks", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "gaia-replay-base-"));
    const curDir = await mkdtemp(path.join(tmpdir(), "gaia-replay-cur-"));

    const stable: AgentEvent[] = [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ];
    await writeEventsFile(baseDir, "task-a", stable);
    await writeEventsFile(curDir, "task-a", stable);

    await writeEventsFile(baseDir, "task-b", [
      turnStart(0),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ]);
    await writeEventsFile(curDir, "task-b", [
      turnStart(0),
      toolStart("t0", "webSearch", { q: "y" }),
      toolEnd("t0", "webSearch"),
      toolStart("t1", "webFetch", { url: "x" }),
      toolEnd("t1", "webFetch"),
      agentEnd(),
    ]);

    await writeEventsFile(baseDir, "task-c", stable);
    await writeEventsFile(curDir, "task-d", stable);

    const report = await runBatchReplay(baseDir, curDir);
    expect(report.identical).toBe(1);
    expect(report.changed).toBe(1);
    expect(report.missingInBaseline).toBe(1);
    expect(report.missingInCurrent).toBe(1);
    expect(report.total).toBe(4);

    const aEntry = report.entries.find((e) => e.taskId === "task-a");
    expect(aEntry?.status).toBe("identical");
    expect(aEntry?.diff?.identical).toBe(true);

    const bEntry = report.entries.find((e) => e.taskId === "task-b");
    expect(bEntry?.status).toBe("changed");
    expect(bEntry?.diff?.toolSequenceChanged).toBe(true);
  });

  it("reports load-error gracefully on bad JSONL", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "gaia-replay-base-"));
    const curDir = await mkdtemp(path.join(tmpdir(), "gaia-replay-cur-"));

    await writeEventsFile(baseDir, "task-x", [agentEnd()]);
    const eventsDir = path.join(curDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, "task-x.jsonl"), "{not json}\n");

    const report = await runBatchReplay(baseDir, curDir);
    expect(report.errors).toBe(1);
    const entry = report.entries.find((e) => e.taskId === "task-x");
    expect(entry?.status).toBe("load-error");
    expect(entry?.error).toMatch(/invalid JSON/);
  });
});
