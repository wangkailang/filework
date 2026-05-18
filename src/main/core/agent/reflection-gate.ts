// Post-turn verdict hook: deterministic rules first, optional cheap-LLM
// fallback when rules abstain. Opt-in via skill frontmatter `reflect: true`.

import type { LanguageModel } from "ai";
import { generateText } from "ai";
import type { TokenUsage, TurnEndReason } from "./events";

export interface ToolCallSummary {
  name: string;
  success: boolean;
  result: unknown;
}

export interface TurnSummary {
  agentId: string;
  turnIndex: number;
  finalText: string;
  toolCalls: ToolCallSummary[];
  endReason: TurnEndReason;
  usage?: TokenUsage;
}

export type ReflectionVerdict =
  | { kind: "continue" }
  | {
      kind: "retry";
      feedback: string;
      /**
       * When true, AgentLoop must call the next `streamText` pass with an
       * empty tool set so the model physically cannot invoke any tools.
       * Used by `missingFinalAnswer` to recover from step-budget exhaustion
       * — letting the model keep its tools on retry tends to re-exhaust
       * the budget instead of producing the final answer.
       */
      forceNoTools?: boolean;
    }
  | { kind: "abort"; reason: string };

export type ReflectHook = (
  summary: TurnSummary,
  signal?: AbortSignal,
) => Promise<ReflectionVerdict>;

export type ReflectionRule = (turn: TurnSummary) => ReflectionVerdict | null;

export interface ReflectionGateConfig {
  model?: LanguageModel;
  rules?: ReflectionRule[];
  /** Default true. Set false to skip LLM when all rules abstain. */
  llmFallback?: boolean;
  /**
   * Override the default LLM-fallback prompt. Receives the turn summary
   * and returns the full prompt string sent to `generateText`. Used by
   * harnesses (e.g. GAIA) that need question-aware answer verification
   * — they can close over additional context (question text, expected
   * format) the generic prompt doesn't have access to.
   */
  llmPromptBuilder?: (turn: TurnSummary) => string;
  /**
   * When the LLM fallback returns a `retry` verdict, also stamp it with
   * `forceNoTools: true` so AgentLoop strips tools on the retry pass.
   * Sensible for verifier-style fallbacks where the model already
   * gathered all info it needs and the retry is purely a re-format.
   * Default false (preserves chat-path behavior).
   */
  llmForceNoTools?: boolean;
  /**
   * Sampling temperature for the LLM-fallback `generateText` call.
   * Default unset (uses provider default). Eval harnesses should set
   * this to `0` for reproducible verifier verdicts.
   */
  llmTemperature?: number;
}

export const pdfParseFailure: ReflectionRule = (turn) => {
  for (const call of turn.toolCalls) {
    if (call.success) continue;
    const r = call.result as { error?: unknown } | null | undefined;
    const errorStr = r && typeof r.error === "string" ? r.error : "";
    // Trigger only when the failure is clearly PDF-related — either the
    // tool name advertises PDF context, or the error message explicitly
    // mentions PDF. Plain "parse" matches (JSON / CSV / etc.) abstain
    // here so the generic feedback message doesn't get misapplied.
    const looksPdfTool = /pdf/i.test(call.name);
    const mentionsPdf = /pdf/i.test(errorStr);
    if (looksPdfTool || mentionsPdf) {
      return {
        kind: "retry",
        feedback:
          "工具调用失败：PDF 解析报错。请直接告知用户解析失败的原因，建议重新上传或导出为文本格式。不要凭空生成 PDF 内容。",
      };
    }
  }
  const hallmarks = ["could not be parsed", "无法解析", "解析失败"];
  const finalLower = turn.finalText.toLowerCase();
  for (const h of hallmarks) {
    if (finalLower.includes(h)) {
      return { kind: "continue" };
    }
  }
  return null;
};

export const toolDeniedSequence: ReflectionRule = (turn) => {
  let denied = 0;
  for (const call of turn.toolCalls) {
    const r = call.result as { denied?: boolean } | null | undefined;
    if (r && r.denied === true) denied++;
  }
  if (denied >= 2) {
    return {
      kind: "abort",
      reason: `User denied ${denied} tool call(s) this turn — stopping to avoid further denials.`,
    };
  }
  return null;
};

export const emptyAssistantWithTools: ReflectionRule = (turn) => {
  if (
    turn.toolCalls.length > 0 &&
    turn.finalText.trim().length === 0 &&
    turn.endReason !== "tool_calls"
  ) {
    return {
      kind: "retry",
      feedback:
        "你调用了工具但没有生成任何文本。请用一两句话告诉用户工具返回了什么、下一步建议怎么做。",
    };
  }
  return null;
};

// KEEP IN SYNC with `FINAL_ANSWER_RE` in src/eval/gaia/scorer.ts:126.
// A "valid" FINAL ANSWER line is one where the scorer would extract a
// non-empty payload — so the rule's accept/reject is symmetric with what
// the scorer would actually grade. If you change one, change both.
const FINAL_ANSWER_LINE_RE = /\bFINAL\s*ANSWER\s*[:-]?\s*([\s\S]+?)\s*$/i;

/**
 * Opt-in rule for evaluation harnesses that mandate a `FINAL ANSWER: <x>`
 * sentinel (e.g. GAIA). Triggers `retry` with feedback when the assistant
 * finished a streamText pass without emitting a line the scorer would
 * accept.
 *
 * Important: the gate is invoked once per completed `streamText` pass
 * (not per internal step). At that point `endReason === "tool_calls"`
 * means the model exhausted `stopWhen`/`maxStepsPerTurn` while still
 * planning tool calls — exactly when we want the retry feedback to say
 * "stop calling tools and emit your best answer."
 *
 * Skips when `finalText` is empty — that case belongs to
 * `emptyAssistantWithTools` or the harness's own failure tagging.
 *
 * NOT included in `builtinRules()` / `defaultRules()` because the protocol
 * is harness-specific; passing this into `createReflectionGate({ rules })`
 * is the supported integration point.
 */
export const missingFinalAnswer: ReflectionRule = (turn) => {
  if (turn.finalText.trim().length === 0) return null;
  const ok = turn.finalText.split(/\r?\n/).some((line) => {
    const m = line.match(FINAL_ANSWER_LINE_RE);
    return m !== null && m[1].trim().length > 0;
  });
  if (ok) return null;
  const budgetExhausted = turn.endReason === "tool_calls";
  return {
    kind: "retry",
    forceNoTools: true,
    feedback:
      (budgetExhausted
        ? "You ran out of tool-call budget without emitting a final answer. "
        : "Your previous response did not end with the required `FINAL ANSWER: <answer>` line. ") +
      "Re-emit a final response that ends with exactly:\n\n" +
      "    FINAL ANSWER: <your answer>\n\n" +
      "If you cannot determine the answer with certainty, commit to your best guess based on the evidence you've gathered. DO NOT write `FINAL ANSWER: unknown`, `N/A`, or `I don't know` — those always score 0.",
  };
};

/**
 * Default rules attached on the main agent path. Excludes
 * `emptyAssistantWithTools` because it false-positives on legitimate
 * silent-after-tool flows (askClarification, CI dispatch). Safe for
 * always-on use.
 */
export function defaultRules(): ReflectionRule[] {
  return [pdfParseFailure, toolDeniedSequence];
}

/** Full rule set — opt-in via skill frontmatter `reflect: true`. */
export function builtinRules(): ReflectionRule[] {
  return [pdfParseFailure, toolDeniedSequence, emptyAssistantWithTools];
}

const LLM_REFLECT_PROMPT = `你是一个质量评审助手。下面是一个 AI 助手刚完成的一轮对话片段，请判断它是否合格交付。

只输出 JSON，不要任何其它文本，格式如下：
{ "verdict": "continue" | "retry" | "abort", "feedback": "..." }

- verdict=continue：质量合格，可以交付给用户。
- verdict=retry：有可纠正的问题（例如：忽略了工具失败、答非所问、格式不符），feedback 简短描述要让助手补救什么。
- verdict=abort：无法挽救，feedback 说明终止原因。

待评审的回合：
`;

interface LlmVerdictJson {
  verdict?: "continue" | "retry" | "abort";
  feedback?: string;
  reason?: string;
}

function serializeTurnForReflection(turn: TurnSummary): string {
  const lines: string[] = [];
  lines.push(`endReason: ${turn.endReason}`);
  if (turn.toolCalls.length > 0) {
    lines.push("");
    lines.push("Tool calls:");
    for (const c of turn.toolCalls) {
      const out =
        typeof c.result === "string"
          ? c.result.slice(0, 400)
          : JSON.stringify(c.result).slice(0, 400);
      lines.push(`- ${c.name} → success=${c.success} | ${out}`);
    }
  }
  lines.push("");
  lines.push("Assistant text:");
  lines.push(turn.finalText.slice(0, 4000));
  return lines.join("\n");
}

function parseLlmVerdict(text: string): ReflectionVerdict {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  let json: LlmVerdictJson | null = null;
  try {
    json = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        json = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        json = null;
      }
    }
  }
  if (!json || typeof json !== "object") return { kind: "continue" };

  if (json.verdict === "retry") {
    return {
      kind: "retry",
      feedback: json.feedback ?? "请重新检查并修正回答。",
    };
  }
  if (json.verdict === "abort") {
    return {
      kind: "abort",
      reason: json.reason ?? json.feedback ?? "Reflection abort verdict.",
    };
  }
  return { kind: "continue" };
}

async function runLlmReflection(
  model: LanguageModel,
  turn: TurnSummary,
  promptBuilder: (t: TurnSummary) => string,
  temperature: number | undefined,
  signal?: AbortSignal,
): Promise<ReflectionVerdict> {
  try {
    const { text } = await generateText({
      model,
      prompt: promptBuilder(turn),
      abortSignal: signal,
      ...(temperature !== undefined && { temperature }),
    });
    return parseLlmVerdict(text);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(
      "[ReflectionGate] LLM verdict failed; falling back to continue:",
      err instanceof Error ? err.message : err,
    );
    return { kind: "continue" };
  }
}

const defaultLlmPromptBuilder = (turn: TurnSummary): string =>
  LLM_REFLECT_PROMPT + serializeTurnForReflection(turn);

export function createReflectionGate(
  config: ReflectionGateConfig = {},
): ReflectHook {
  const rules = config.rules ?? builtinRules();
  const llmFallback = config.llmFallback !== false;
  const promptBuilder = config.llmPromptBuilder ?? defaultLlmPromptBuilder;
  const llmForceNoTools = config.llmForceNoTools === true;

  return async (turn, signal) => {
    for (const rule of rules) {
      const verdict = rule(turn);
      if (verdict !== null) return verdict;
    }
    if (llmFallback && config.model) {
      const verdict = await runLlmReflection(
        config.model,
        turn,
        promptBuilder,
        config.llmTemperature,
        signal,
      );
      if (llmForceNoTools && verdict.kind === "retry") {
        return { ...verdict, forceNoTools: true };
      }
      return verdict;
    }
    return { kind: "continue" };
  };
}
