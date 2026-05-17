/**
 * GAIA runner — for each question, instantiate AgentLoop, capture
 * the full event stream, extract the final answer, score it, and
 * write everything to disk.
 *
 * Layout of `outputDir`:
 *
 *   <outputDir>/
 *     summary.json
 *     per-question/<task_id>.json
 *     events/<task_id>.jsonl
 *     workspaces/<task_id>/...    (cleaned up after each question)
 *
 * Concurrency is currently hard-coded to 1 — sequential runs are
 * easier to debug, and the agent's tool calls (web, file I/O) don't
 * benefit much from parallelism on a single machine.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createModelWithAdapter } from "../../main/ai/adapters";
import { AgentLoop } from "../../main/core/agent/agent-loop";
import type { AgentEvent } from "../../main/core/agent/events";

import { filterQuestions, loadGaiaDataset } from "./dataset";
import { calculateCost } from "./pricing";
import { renderReports } from "./report";
import {
  extractFinalAnswer,
  groupByLevel,
  median,
  scoreAnswer,
} from "./scorer";
import { buildEvalToolRegistry, evalContextFactory } from "./tool-registry";
import type {
  FailureTag,
  NormalizedQuestion,
  QuestionResult,
  RunnerOptions,
  RunSummary,
  ToolCallRecord,
} from "./types";
import { setupQuestionWorkspace } from "./workspace";

const DEFAULT_PER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

const buildSystemPrompt = (
  q: NormalizedQuestion,
  attachmentPath: string | null,
): string => {
  void q;
  const sections: string[] = [
    "You are an autonomous research agent participating in the GAIA benchmark.",
    "",
    "Solve the question below using the available tools. Be precise and concise.",
    "",
    "## Answer protocol (CRITICAL)",
    "Your response MUST end with EXACTLY this on its own line:",
    "",
    "    FINAL ANSWER: <your answer>",
    "",
    "Rules — non-negotiable:",
    "- The line is REQUIRED on every response, including when you cannot solve the task.",
    "- If you cannot find the answer after a reasonable attempt, write:",
    "    FINAL ANSWER: unknown",
    "- The answer must be a single value, list, or short phrase — no explanations,",
    "  no unit unless the question requires it, no leading 'The answer is'.",
    "- The grader normalises whitespace, case, and obvious cosmetic differences but",
    "  otherwise checks exact match.",
    "- DO NOT narrate your reasoning in place of the answer. Reasoning is fine in",
    "  the body of your response, but the final line is the answer alone.",
    "",
    "## Stop conditions (give up gracefully)",
    "- If you have tried 3 or more distinct approaches and none worked, STOP and emit",
    "  `FINAL ANSWER: unknown`. Do not keep trying variations.",
    "- If a required resource is genuinely unavailable (e.g. a video has no captions",
    "  and you have no other way to access its content), STOP and emit",
    "  `FINAL ANSWER: unknown`.",
    "- Running out of step budget without emitting FINAL ANSWER scores you 0; emitting",
    "  `FINAL ANSWER: unknown` scores you 0 too but lets the harness measure where you got stuck.",
    "",
    "## Available capabilities",
    "- File tools: listDirectory, readFile, writeFile, runCommand, ...",
    "- Web tools: webFetch (and webSearch / webScrape if configured)",
    "- YouTube transcripts via youtubeTranscript",
    "- Document parsers: readPdfText, readDocxText, readXlsxSheet, readPptxSlides, ...",
    "- runCommand runs unsandboxed shell — you can use python3, curl, awk, etc.",
    "",
    "## Constraints",
    "- Do NOT call askClarification (it is not available in eval mode).",
    "- Prefer the dedicated parser (readPdfText, readPptxSlides) over reading raw bytes.",
    "- If a tool returns an error, try a different approach rather than retrying identically.",
    "- Tool results are truncated above ~30KB. If you need a different slice of a long",
    "  document, request a smaller range explicitly (e.g. by page or by sheet).",
  ];
  if (attachmentPath) {
    sections.push(
      "",
      `## Attached file`,
      `An attachment for this question is available at: ${attachmentPath}`,
      "Use the appropriate parser tool on this absolute path.",
    );
  }
  return sections.join("\n");
};

// ─── Per-question execution ──────────────────────────────────────────

interface CollectedEvents {
  toolCalls: ToolCallRecord[];
  stepCount: number;
  reflectionFired: boolean;
  finalText: string;
  totalUsage?: { input: number; output: number; total: number };
  endStatus?: "completed" | "failed" | "cancelled";
  endError?: string;
}

const collectFromEventStream = async (
  events: AsyncIterable<AgentEvent>,
  eventsLogPath: string,
): Promise<CollectedEvents> => {
  const partial: Record<
    string,
    { name: string; args: unknown; start: number }
  > = {};
  const toolCalls: ToolCallRecord[] = [];
  let stepCount = 0;
  let reflectionFired = false;
  const finalTextChunks: string[] = [];
  let totalUsage: CollectedEvents["totalUsage"];
  let endStatus: CollectedEvents["endStatus"];
  let endError: string | undefined;

  for await (const e of events) {
    await appendFile(eventsLogPath, `${JSON.stringify(e)}\n`, "utf-8");
    switch (e.type) {
      case "turn_start":
        stepCount += 1;
        break;
      case "tool_execution_start":
        partial[e.toolCallId] = {
          name: e.toolName,
          args: e.args,
          start: Date.now(),
        };
        break;
      case "tool_execution_end": {
        const p = partial[e.toolCallId];
        const durationMs = p ? Date.now() - p.start : e.durationMs;
        toolCalls.push({
          name: e.toolName,
          args: p?.args,
          result: e.success ? e.result : undefined,
          error: e.success ? undefined : String(e.result),
          durationMs,
        });
        delete partial[e.toolCallId];
        break;
      }
      case "message_end":
        if (e.finalText) finalTextChunks.push(e.finalText);
        break;
      case "reflection_verdict":
        reflectionFired = true;
        break;
      case "agent_end":
        endStatus = e.status;
        if (e.error) endError = e.error.message;
        if (e.finalText) finalTextChunks.push(e.finalText);
        if (e.totalUsage) {
          totalUsage = {
            input: e.totalUsage.inputTokens ?? 0,
            output: e.totalUsage.outputTokens ?? 0,
            total: e.totalUsage.totalTokens ?? 0,
          };
        }
        break;
    }
  }

  return {
    toolCalls,
    stepCount,
    reflectionFired,
    finalText: finalTextChunks.join("\n").trim(),
    totalUsage,
    endStatus,
    endError,
  };
};

const tagFailures = (
  question: NormalizedQuestion,
  collected: CollectedEvents,
  passed: boolean,
  exception?: string,
): FailureTag[] => {
  if (passed) return [];
  const tags: FailureTag[] = [];
  if (exception) tags.push("exception");
  if (collected.endStatus === "cancelled") tags.push("timeout");
  if (collected.toolCalls.length === 0) tags.push("no_tool_calls");
  const errCount = collected.toolCalls.filter((t) => t.error).length;
  if (errCount > 0) tags.push("tool_error");
  if (collected.endError?.toLowerCase().includes("context")) {
    tags.push("context_overflow");
  }
  if (
    question.fileName &&
    !collected.toolCalls.some((t) => {
      const args = JSON.stringify(t.args ?? "");
      return args.includes(question.fileName ?? "");
    })
  ) {
    tags.push("attachment_not_processed");
  }
  if (
    collected.stepCount >= 5 &&
    !collected.reflectionFired &&
    !tags.includes("no_tool_calls")
  ) {
    tags.push("reflection_not_fired");
  }
  if (
    !tags.includes("no_tool_calls") &&
    !tags.includes("exception") &&
    collected.toolCalls.length >= 2 &&
    collected.finalText.length > 0
  ) {
    tags.push("wrong_answer_correct_path");
  }
  return tags;
};

const runWithTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T | { __timeout: true }> =>
  Promise.race([
    promise,
    new Promise<{ __timeout: true }>((resolve) => {
      const t = setTimeout(() => {
        controller.abort(new Error("per-question timeout"));
        resolve({ __timeout: true });
      }, timeoutMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);

interface PerQuestionDeps {
  fetchImpl: typeof fetch;
  tavilyKey?: string | null;
  firecrawlKey?: string | null;
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const runOneQuestion = async (
  question: NormalizedQuestion,
  outputDir: string,
  datasetDir: string,
  deps: PerQuestionDeps,
  timeoutMs: number,
): Promise<QuestionResult> => {
  const eventsLogPath = path.join(
    outputDir,
    "events",
    `${question.taskId}.jsonl`,
  );
  await mkdir(path.dirname(eventsLogPath), { recursive: true });
  await writeFile(eventsLogPath, "", "utf-8");

  const startedAt = Date.now();
  const ws = await setupQuestionWorkspace({
    question,
    datasetDir,
    outputDir,
  });

  const controller = new AbortController();
  let exception: string | undefined;
  let collected: CollectedEvents | null = null;

  try {
    const registry = buildEvalToolRegistry({
      fetchImpl: deps.fetchImpl,
      tavilyKey: deps.tavilyKey,
      firecrawlKey: deps.firecrawlKey,
    });

    const { model } = createModelWithAdapter({
      provider: deps.provider,
      apiKey: deps.apiKey,
      model: deps.model,
      baseUrl: deps.baseUrl,
    });

    const loop = new AgentLoop({
      workspace: ws.workspace,
      model,
      tools: registry.toAiSdkTools({
        ctxFactory: evalContextFactory(ws.workspace, controller.signal),
      }),
      systemPrompt: buildSystemPrompt(question, ws.attachmentPath),
      maxStepsPerTurn: 12,
      signal: controller.signal,
    });

    const result = await runWithTimeout(
      collectFromEventStream(loop.run(question.question), eventsLogPath),
      timeoutMs,
      controller,
    );

    if ("__timeout" in result) {
      collected = {
        toolCalls: [],
        stepCount: 0,
        reflectionFired: false,
        finalText: "",
        endStatus: "cancelled",
      };
    } else {
      collected = result;
    }
  } catch (err) {
    exception =
      err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  } finally {
    await ws.cleanup().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  const predicted = collected ? extractFinalAnswer(collected.finalText) : null;
  const score = scoreAnswer(predicted, question.groundTruth);
  const failureTags = tagFailures(
    question,
    collected ?? {
      toolCalls: [],
      stepCount: 0,
      reflectionFired: false,
      finalText: "",
    },
    score.passed,
    exception,
  );

  const estimatedCostUsd =
    calculateCost(deps.model, collected?.totalUsage) ?? undefined;

  const result: QuestionResult = {
    taskId: question.taskId,
    level: question.level,
    question: question.question,
    attachment: ws.attachmentPath,
    groundTruth: question.groundTruth,
    predicted,
    passed: score.passed,
    normalized: {
      groundTruth: score.normalizedTruth,
      predicted: score.normalizedPredicted,
    },
    durationMs,
    tokenUsage: collected?.totalUsage,
    estimatedCostUsd,
    toolCalls: collected?.toolCalls ?? [],
    stepCount: collected?.stepCount ?? 0,
    reflectionFired: collected?.reflectionFired ?? false,
    failureTags,
    exception,
    eventsPath: path.relative(outputDir, eventsLogPath),
  };

  const perQuestionPath = path.join(
    outputDir,
    "per-question",
    `${question.taskId}.json`,
  );
  await mkdir(path.dirname(perQuestionPath), { recursive: true });
  await writeFile(perQuestionPath, JSON.stringify(result, null, 2), "utf-8");

  return result;
};

// ─── Summary ─────────────────────────────────────────────────────────

const buildSummary = (
  results: QuestionResult[],
  opts: RunnerOptions,
  startedAt: string,
): RunSummary => {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const tagCounts: Partial<Record<FailureTag, number>> = {};
  for (const r of results) {
    for (const tag of r.failureTags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }
  const durations = results.map((r) => r.durationMs);
  const byLevel: RunSummary["byLevel"] = {};
  for (const lvl of [1, 2, 3] as const) {
    const sub = results.filter((r) => r.level === lvl);
    if (sub.length === 0) continue;
    const pass = sub.filter((r) => r.passed).length;
    byLevel[String(lvl)] = {
      n: sub.length,
      passed: pass,
      accuracy: pass / sub.length,
    };
  }

  // Cost aggregation. `estimatedCostUsd` is undefined for unpriced
  // models — those rows are excluded from both total and median so we
  // don't dilute the figure with synthetic zeros.
  const costs = results
    .map((r) => r.estimatedCostUsd)
    .filter((c): c is number => typeof c === "number");
  const totalCostUsd = costs.reduce((a, b) => a + b, 0);
  const medianCostUsd = median(costs);

  return {
    config: {
      level:
        typeof opts.level === "number"
          ? (String(opts.level) as "1" | "2" | "3")
          : opts.level,
      limit: opts.limit,
      provider: opts.provider,
      model: opts.model,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    totals: { questions: results.length, passed, failed },
    accuracy: results.length > 0 ? passed / results.length : 0,
    byLevel,
    duration: {
      totalMs: durations.reduce((a, b) => a + b, 0),
      medianMs: median(durations),
    },
    cost: {
      totalUsd: totalCostUsd,
      perQuestionMedianUsd: medianCostUsd,
    },
    failureTags: tagCounts,
  };
};

// ─── Public entry ────────────────────────────────────────────────────

export interface RunGaiaResult {
  summary: RunSummary;
  results: QuestionResult[];
}

export const runGaia = async (
  opts: RunnerOptions & {
    /** When omitted the runner uses Node's global `fetch`. */
    fetchImpl?: typeof fetch;
    tavilyKey?: string | null;
    firecrawlKey?: string | null;
    /** Per-question progress callback — surfaced to the CLI. */
    onProgress?: (info: {
      index: number;
      total: number;
      result: QuestionResult;
    }) => void;
  },
): Promise<RunGaiaResult> => {
  const startedAt = new Date().toISOString();
  await mkdir(opts.outputDir, { recursive: true });

  const { questions: all, skipped } = await loadGaiaDataset(opts.datasetDir);
  if (skipped > 0) {
    console.warn(`[gaia] skipped ${skipped} malformed dataset rows`);
  }
  const filtered = filterQuestions(all, {
    level: opts.level,
    limit: opts.limit,
  });

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs =
    opts.perQuestionTimeoutMs ?? DEFAULT_PER_QUESTION_TIMEOUT_MS;
  const deps: PerQuestionDeps = {
    fetchImpl,
    tavilyKey: opts.tavilyKey ?? process.env.TAVILY_API_KEY ?? null,
    firecrawlKey: opts.firecrawlKey ?? process.env.FIRECRAWL_API_KEY ?? null,
    provider: opts.provider,
    apiKey: opts.apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
  };

  const results: QuestionResult[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const q = filtered[i];
    const result = await runOneQuestion(
      q,
      opts.outputDir,
      opts.datasetDir,
      deps,
      timeoutMs,
    );
    results.push(result);
    opts.onProgress?.({ index: i, total: filtered.length, result });
  }

  // groupByLevel is still useful when callers want a quick lookup; not
  // exported in the summary but kept available for downstream tooling.
  void groupByLevel(filtered);

  const summary = buildSummary(results, opts, startedAt);
  await writeFile(
    path.join(opts.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );

  // Phase 2: human-readable companions to summary.json. Kept best-
  // effort — a render failure here shouldn't lose the JSON results.
  try {
    const { failures, toolUsage } = renderReports(results, summary);
    await writeFile(
      path.join(opts.outputDir, "failures.md"),
      failures,
      "utf-8",
    );
    await writeFile(
      path.join(opts.outputDir, "tool-usage.md"),
      toolUsage,
      "utf-8",
    );
  } catch (err) {
    console.warn(
      `[gaia] failed to render Markdown reports: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { summary, results };
};
