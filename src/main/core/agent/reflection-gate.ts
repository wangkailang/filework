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
  | { kind: "retry"; feedback: string }
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
  signal?: AbortSignal,
): Promise<ReflectionVerdict> {
  try {
    const { text } = await generateText({
      model,
      prompt: LLM_REFLECT_PROMPT + serializeTurnForReflection(turn),
      abortSignal: signal,
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

export function createReflectionGate(
  config: ReflectionGateConfig = {},
): ReflectHook {
  const rules = config.rules ?? builtinRules();
  const llmFallback = config.llmFallback !== false;

  return async (turn, signal) => {
    for (const rule of rules) {
      const verdict = rule(turn);
      if (verdict !== null) return verdict;
    }
    if (llmFallback && config.model) {
      return runLlmReflection(config.model, turn, signal);
    }
    return { kind: "continue" };
  };
}
