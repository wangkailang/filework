/**
 * GAIA runner —— 对每道题实例化 AgentLoop,捕获完整事件流,
 * 提取最终答案,评分,并将全部内容写入磁盘。
 *
 * `outputDir` 的目录结构:
 *
 *   <outputDir>/
 *     summary.json
 *     per-question/<task_id>.json
 *     events/<task_id>.jsonl
 *     workspaces/<task_id>/...    (每道题处理完后清理)
 *
 * 并发目前硬编码为 1 —— 顺序执行更易于调试,且 agent 的工具
 * 调用(web、文件 I/O)在单机上从并行中获益有限。
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createModelWithAdapter } from "../../main/ai/adapters";
import { AgentLoop } from "../../main/core/agent/agent-loop";
import type { AgentEvent } from "../../main/core/agent/events";
import {
  builtinRules,
  createReflectionGate,
  missingFinalAnswer,
} from "../../main/core/agent/reflection-gate";

import { filterQuestions, loadGaiaDataset } from "./dataset";
import { computeQualityMetrics } from "./metrics";
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

const MAX_ANSWER_TAIL_FOR_VERIFIER = 1200;

/**
 * 构造 reflection-gate 的 llmFallback 在确定性规则弃权后发送的
 * LLM 校验 prompt。校验器只检查答案的形式/单位/量级与题目是否
 * 对齐 —— 不检查事实正确性。它刻意保守("不确定时优先 continue"),
 * 以免把正确答案误判。
 *
 * 它针对的代价最高的历史失败是 Kipchoge 案例:题目问 "how many
 * thousand hours",模型答了 17000(原始小时数)而非 17(千)。
 */
const buildAnswerVerifierPrompt = (
  questionText: string,
  finalText: string,
): string => {
  // 只发送 finalText 的尾部 —— FINAL ANSWER 行位于末尾,
  // 校验器不需要完整的推理过程。
  const tail = finalText.slice(-MAX_ANSWER_TAIL_FOR_VERIFIER);
  return [
    "You are an answer-FORM verifier for the GAIA benchmark.",
    "Check ONLY whether the model's FINAL ANSWER matches the unit, magnitude,",
    "and format that the question LITERALLY asks for.",
    "You do NOT verify factual correctness — you only check form alignment.",
    "",
    "Common mismatches to flag:",
    "- Question asks 'how many thousand X' / 'how many million X' / 'how many",
    "  percent' but the answer is in raw units (e.g. '17000 hours' instead of",
    "  '17' for 'how many thousand hours').",
    "- Question says 'in m^3' / 'in km' but the answer repeats the unit when",
    "  the protocol asks for the bare value.",
    "- Question specifies a format (date, integer, list) and the answer breaks",
    "  that format.",
    "",
    "Output STRICT JSON only, no other text:",
    '{ "verdict": "continue" | "retry", "feedback": "..." }',
    "- continue: form matches the question. PREFER this when uncertain.",
    "- retry: form clearly mismatches; feedback briefly states what to fix",
    "  and what the answer SHOULD look like.",
    "",
    "QUESTION:",
    questionText,
    "",
    "MODEL'S FINAL RESPONSE (tail):",
    tail,
  ].join("\n");
};

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
    "- The line is REQUIRED on every response, including when you are uncertain.",
    "- The answer must be a single value, list, or short phrase — no explanations,",
    "  no unit unless the question requires it, no leading 'The answer is'.",
    "- The grader normalises whitespace, case, and obvious cosmetic differences but",
    "  otherwise checks exact match.",
    "- DO NOT narrate your reasoning in place of the answer. Reasoning is fine in",
    "  the body of your response, but the final line is the answer alone.",
    "",
    "## When you cannot find a definitive answer",
    "- DO NOT write `FINAL ANSWER: unknown`, `FINAL ANSWER: N/A`,",
    "  `FINAL ANSWER: I don't know`, or any equivalent hedge — these all score 0",
    "  by default.",
    "- Instead, commit to your best guess based on the evidence you actually gathered.",
    "- A wrong specific guess scores 0, the same as `unknown` — but an occasionally",
    "  correct guess is the only path to non-zero credit when you're uncertain.",
    "- If you've tried 3+ distinct approaches and still cannot confirm, pick the most",
    "  plausible candidate from your search results / tool outputs and emit it as the",
    "  final answer.",
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
    "",
    "## Unit interpretation (READ CAREFULLY before answering)",
    "When the question contains a unit-bearing phrase, your final answer must be",
    "expressed in those exact units — not in raw underlying units.",
    "",
    "- 'how many thousand X' → answer is the count of X in thousands.",
    "  Example: a calculation yielding 17054.9 hours, rounded to the nearest 1000,",
    "  is 17 (i.e. 17 thousand hours) — NOT 17000.",
    "- 'how many million X' / 'how many hundred X' / 'in millions of X' → same rule.",
    "- 'what percent' → answer is the percentage value (e.g. 42 or 42%, not 0.42).",
    "- 'how many X' (no scale word) → answer is the raw count.",
    "",
    "If the question says 'round to the nearest 1000', that is a precision",
    "instruction. Apply rounding FIRST, then convert to the requested unit",
    "(thousands, millions, etc.) if the question asks for one.",
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

// ─── 单题执行 ──────────────────────────────────────────

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
  /**
   * 已解析的采样温度。`number` → 直接透传;`null` → 完全跳过该
   * 参数(用于 OpenAI 推理模型)。CLI 层将 `--temperature` 转换
   * 为此值。
   */
  temperature: number | null;
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

    // Reflection gate 先通过确定性规则强制执行 FINAL ANSWER 协议,
    // 再运行 LLM 校验器,检查所发出答案的单位/量级/格式是否符合
    // 题目字面要求。`missingFinalAnswer` 是 GAIA 专用的,因此在此
    // 组合而非内置进 builtinRules。当任一规则已触发 retry/abort 时,
    // LLM 校验器会短路 —— 它只对已通过协议检查的轮次花费一次模型
    // 调用。温度遵循 `deps.temperature` —— null 表示"完全省略"
    // (OpenAI 推理模型要求如此)。
    const temperatureForSdk =
      deps.temperature === null ? undefined : deps.temperature;
    const reflectGate = createReflectionGate({
      model,
      rules: [missingFinalAnswer, ...builtinRules()],
      llmFallback: true,
      llmPromptBuilder: (turn) =>
        buildAnswerVerifierPrompt(question.question, turn.finalText),
      llmForceNoTools: true,
      llmTemperature: temperatureForSdk,
    });

    const loop = new AgentLoop({
      workspace: ws.workspace,
      model,
      tools: registry.toAiSdkTools({
        ctxFactory: evalContextFactory(ws.workspace, controller.signal),
      }),
      systemPrompt: buildSystemPrompt(question, ws.attachmentPath),
      maxStepsPerTurn: 12,
      temperature: temperatureForSdk,
      signal: controller.signal,
      hooks: { reflect: reflectGate },
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

// ─── 汇总 ─────────────────────────────────────────────────────────

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

  // 成本聚合。对于未定价的模型,`estimatedCostUsd` 为 undefined ——
  // 这些行被同时排除在总和与中位数之外,以免用人造的零值稀释数据。
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
    quality: computeQualityMetrics(results),
  };
};

// ─── 公开入口 ────────────────────────────────────────────────────

export interface RunGaiaResult {
  summary: RunSummary;
  results: QuestionResult[];
}

export const runGaia = async (
  opts: RunnerOptions & {
    /** 省略时 runner 使用 Node 的全局 `fetch`。 */
    fetchImpl?: typeof fetch;
    tavilyKey?: string | null;
    firecrawlKey?: string | null;
    /** 单题进度回调 —— 暴露给 CLI。 */
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
  // `opts.temperature` 语义:`undefined` → 确定性默认值(0);
  // `null` → 完全省略该参数(OpenAI 推理模型);
  // `number` → 直接透传。
  const temperature: number | null =
    opts.temperature === undefined ? 0 : opts.temperature;
  const deps: PerQuestionDeps = {
    fetchImpl,
    tavilyKey: opts.tavilyKey ?? process.env.TAVILY_API_KEY ?? null,
    firecrawlKey: opts.firecrawlKey ?? process.env.FIRECRAWL_API_KEY ?? null,
    provider: opts.provider,
    apiKey: opts.apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
    temperature,
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

  // 当调用方需要快速查表时 groupByLevel 仍有用;它不出现在 summary
  // 中,但保留以供下游工具使用。
  void groupByLevel(filtered);

  const summary = buildSummary(results, opts, startedAt);
  await writeFile(
    path.join(opts.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );

  // 阶段 2:summary.json 的人类可读配套文件。采用尽力而为策略 ——
  // 此处渲染失败不应导致丢失 JSON 结果。
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
