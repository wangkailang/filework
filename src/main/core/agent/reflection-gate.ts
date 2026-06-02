// 回合结束后的裁决钩子:先走确定性规则,规则弃权时可选地回退到廉价 LLM。
// 通过 skill frontmatter `reflect: true` 显式开启。

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
       * 为 true 时,AgentLoop 下一次调用 `streamText` 必须传入空工具集,
       * 使模型物理上无法调用任何工具。供 `missingFinalAnswer` 用于从
       * 步数预算耗尽中恢复 —— 重试时若让模型保留工具,往往会再次耗尽
       * 预算而非产出最终答案。
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
  /** 默认 true。设为 false 时,所有规则弃权后跳过 LLM。 */
  llmFallback?: boolean;
  /**
   * 覆盖默认的 LLM 回退 prompt。接收本回合摘要,返回发送给
   * `generateText` 的完整 prompt 字符串。供需要"问题感知"答案校验的
   * harness(如 GAIA)使用 —— 它们可以闭包捕获通用 prompt 无法访问的
   * 额外上下文(问题文本、期望格式)。
   */
  llmPromptBuilder?: (turn: TurnSummary) => string;
  /**
   * 当 LLM 回退返回 `retry` 裁决时,同时打上 `forceNoTools: true`,
   * 使 AgentLoop 在重试这一遍剥离工具。适用于校验器式回退 —— 此时模型
   * 已收集到所需的全部信息,重试纯粹是重新格式化。
   * 默认 false(保持聊天路径的行为)。
   */
  llmForceNoTools?: boolean;
  /**
   * LLM 回退 `generateText` 调用的采样温度。
   * 默认不设置(使用 provider 默认值)。评测 harness 应将其设为 `0`
   * 以获得可复现的校验器裁决。
   */
  llmTemperature?: number;
}

export const pdfParseFailure: ReflectionRule = (turn) => {
  for (const call of turn.toolCalls) {
    if (call.success) continue;
    const r = call.result as { error?: unknown } | null | undefined;
    const errorStr = r && typeof r.error === "string" ? r.error : "";
    // 仅在失败明确与 PDF 相关时触发 —— 要么工具名表明 PDF 语境,
    // 要么错误信息显式提到 PDF。普通的 "parse" 匹配(JSON / CSV 等)
    // 在此弃权,以免误用这条通用反馈信息。
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
  // 仅在本轮有真实 PDF 工具失败时于上面的 retry 分支处理。模型只在文本里
  // 宣称"解析失败"却没有任何失败的工具调用 —— 不在此放行:`webFetch` 原生
  // 抽取 PDF 文本,裸称"无法解析/请重新上传"通常是过早缴械,交给
  // `prematureConcession` 统一判断是否还有升级途径没试。
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

// 必须与 src/eval/gaia/scorer.ts:126 中的 `FINAL_ANSWER_RE` 保持同步。
// "有效"的 FINAL ANSWER 行是指 scorer 能从中提取出非空载荷的行 —— 因此
// 本规则的接受/拒绝逻辑与 scorer 实际评分时的判定对称。改一处必改两处。
const FINAL_ANSWER_LINE_RE = /\bFINAL\s*ANSWER\s*[:-]?\s*([\s\S]+?)\s*$/i;

/**
 * 供强制要求 `FINAL ANSWER: <x>` 哨兵行的评测 harness(如 GAIA)显式启用的规则。
 * 当助手完成一遍 streamText 却未输出 scorer 能接受的行时,触发带反馈的 `retry`。
 *
 * 重要:此 gate 在每完成一遍 `streamText` 时被调用一次(而非每个内部 step)。
 * 此时 `endReason === "tool_calls"` 表示模型在仍规划工具调用的过程中耗尽了
 * `stopWhen`/`maxStepsPerTurn` —— 正是我们希望让重试反馈说出
 * "停止调用工具,给出你的最佳答案"的时刻。
 *
 * `finalText` 为空时跳过 —— 该情形归 `emptyAssistantWithTools` 或 harness
 * 自身的失败标记处理。
 *
 * 不包含在 `builtinRules()` / `defaultRules()` 中,因为该协议是 harness 专属的;
 * 通过 `createReflectionGate({ rules })` 传入才是受支持的接入点。
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

// 升级层工具:遇阻后本应爬到的更强取数手段。本轮只要调用过其中之一,
// 说明模型在升级而非干等,放弃就不算"过早"。
const ESCALATION_TOOLS = new Set([
  "webFetchRendered",
  "webScrape",
  "browserOpen",
  "browserClick",
  "browserType",
]);

// 任务级"放弃"措辞 —— 只匹配明确宣布不可行的表达,不含"无法确定 / 看不到
// 图片"这类正常的局部不确定,避免误伤。含 PDF 解析失败的裸声明(由收窄后的
// `pdfParseFailure` 下沉到此)。
const CONCESSION_RE =
  /无法完成(这个|此|该|本)?(任务|查询|请求|工作)|超出了?(当前工具|我的能力|工具)|技术限制|无法克服|无法解析|解析失败|请重新上传|cannot complete (this|the)|unable to complete (this|the)|technical limitation|insurmountable|could not be parsed/i;

// 文本若已点名升级途径(Wayback / 渲染 / Firecrawl 等),说明模型已考虑过
// 升级,信任其结论,不再 retry。
const ESCALATION_MENTION_RE =
  /wayback|web\.archive|archive\.org|webFetchRendered|webScrape|firecrawl|渲染|存档|快照/i;

/**
 * 过早放弃护栏:模型宣布任务不可行 / 撞上"技术限制",但本轮既没爬过升级层
 * 工具、文本里也没提到任何升级途径 —— 极可能是一次失败就缴械。retry 一次,
 * 提示还有哪些手段没试。被 `maxReflections`(默认 2)兜底,不会死循环;模型
 * 若已升级过(调用或文本提及)则放行。
 *
 * 收窄后的 `pdfParseFailure` 会把裸"PDF 无法解析"声明下沉到此 —— `webFetch`
 * 原生抽取 PDF,这类声明几乎都是幻觉出来的限制。
 */
export const prematureConcession: ReflectionRule = (turn) => {
  if (!CONCESSION_RE.test(turn.finalText)) return null;
  if (ESCALATION_MENTION_RE.test(turn.finalText)) return null;
  for (const call of turn.toolCalls) {
    if (ESCALATION_TOOLS.has(call.name)) return null;
  }
  return {
    kind: "retry",
    feedback:
      "你宣布任务不可行,但还没穷尽取数手段。放弃前请先升级:页面 404 / 空白时用 `webFetchRendered`(真渲染)→ `webScrape`(Firecrawl,绕反爬)→ 死链改走 Wayback(`https://web.archive.org/web/2023/<url>`);PDF 直接用 `webFetch` 指向 .pdf 链接(可带 query 逐页检索),不要当成无法解析。若这些手段确已全部尝试过,或任务本就不涉及取数,请改为具体说明每种途径分别如何失败,而不是笼统地说'技术限制'。",
  };
};

/**
 * Default rules attached on the main agent path. Excludes
 * `emptyAssistantWithTools` because it false-positives on legitimate
 * silent-after-tool flows (askClarification, CI dispatch). Safe for
 * always-on use.
 */
export function defaultRules(): ReflectionRule[] {
  return [pdfParseFailure, toolDeniedSequence, prematureConcession];
}

/** Full rule set — opt-in via skill frontmatter `reflect: true`. */
export function builtinRules(): ReflectionRule[] {
  return [
    pdfParseFailure,
    toolDeniedSequence,
    emptyAssistantWithTools,
    prematureConcession,
  ];
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
