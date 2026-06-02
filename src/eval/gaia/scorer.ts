/**
 * GAIA scorer —— 与数据集的 `"Final answer"` 字符串做归一化精确匹配。
 *
 * GAIA 官方评分器在比较前会对两边都做归一化,使得表面差异
 * (大小写、标点、"approximately")不会让一个实质正确的答案失败。
 * 我们实现三种匹配模式:
 *
 *   - `exact`   —— 归一化后字符串相等
 *   - `numeric` —— 两边都能解析为数字;差值在 1e-6 内,或四舍五入到
 *                 两位小数后相等
 *   - `list`    —— truth 含列表分隔符(`,` `;` `|`);两边均拆分、
 *                 逐元素归一化、排序后再比较
 *
 * 纯模块 —— 无 I/O,无 AI-SDK 导入,完全可单元测试。
 */

import type { GaiaLevel, NormalizedQuestion } from "./types";

const FUZZ_PREFIXES =
  /^(approximately|about|around|roughly|exactly|nearly|over|under|at least|at most|more than|less than)\s+/i;

/**
 * 转小写,去除首尾空白 + 引号 + 模糊量词,折叠内部空白,
 * 删除千分位分隔符 / $ / %。
 *
 * 保留小数点与负号,使结果仍可进行数值解析。
 */
export const normalizeForScoring = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(FUZZ_PREFIXES, "")
    .replace(/[,$%]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// 从归一化字符串中提取开头的数字字面量。数值评分路径用它来宽容
// 模型从题目里照抄的尾随单位(例如 "0.1777 m^3" 对照 truth
// "0.1777")。当字符串不以数字开头时返回 NaN —— 开头是无关内容
// 时仍判为失败,以免容差掩盖错误答案。
const LEADING_NUMBER_RE = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i;
const tryLeadingNumber = (s: string): number => {
  const m = s.match(LEADING_NUMBER_RE);
  return m ? Number(m[0]) : NaN;
};

const LIST_DELIM = /[,;|]/;

const isListLike = (s: string): boolean => LIST_DELIM.test(s);

const sortJoinList = (s: string): string =>
  s
    .split(LIST_DELIM)
    .map((x) => normalizeForScoring(x))
    .filter((x) => x.length > 0)
    .sort()
    .join(",");

export type MatchType = "exact" | "numeric" | "list" | "fail";

export interface ScoreResult {
  passed: boolean;
  normalizedPredicted: string;
  normalizedTruth: string;
  matchType: MatchType;
}

/**
 * 对单个答案对评分。当从 agent 输出中提取失败时 `predicted` 可能为
 * `null` —— 这种情况一律评为失败。
 */
export const scoreAnswer = (
  predicted: string | null,
  truth: string,
): ScoreResult => {
  const nt = normalizeForScoring(truth);
  if (predicted === null || predicted.trim().length === 0) {
    return {
      passed: false,
      normalizedPredicted: "",
      normalizedTruth: nt,
      matchType: "fail",
    };
  }
  const np = normalizeForScoring(predicted);

  if (np === nt) {
    return {
      passed: true,
      normalizedPredicted: np,
      normalizedTruth: nt,
      matchType: "exact",
    };
  }

  // 数值路径 —— 先用严格的 `Number()`;若任一边失败,则退回到
  // 提取开头数字(处理 "0.1777 m^3" 对 "0.1777" 的情形,模型在此
  // 照抄了题目本已写明的单位)。
  const pn = Number.isFinite(Number(np)) ? Number(np) : tryLeadingNumber(np);
  const tn = Number.isFinite(Number(nt)) ? Number(nt) : tryLeadingNumber(nt);
  if (Number.isFinite(pn) && Number.isFinite(tn) && np !== "" && nt !== "") {
    const close = Math.abs(pn - tn) < 1e-6 || pn.toFixed(2) === tn.toFixed(2);
    return {
      passed: close,
      normalizedPredicted: np,
      normalizedTruth: nt,
      matchType: close ? "numeric" : "fail",
    };
  }

  // 列表路径 —— truth 含分隔符,作为(排序后的)集合比较。
  if (isListLike(truth)) {
    const sjp = sortJoinList(predicted);
    const sjt = sortJoinList(truth);
    const eq = sjp === sjt && sjt.length > 0;
    return {
      passed: eq,
      normalizedPredicted: sjp,
      normalizedTruth: sjt,
      matchType: eq ? "list" : "fail",
    };
  }

  return {
    passed: false,
    normalizedPredicted: np,
    normalizedTruth: nt,
    matchType: "fail",
  };
};

// ─── 最终答案提取 ─────────────────────────────────────────

// 须与 src/main/core/agent/reflection-gate.ts 中的
// `FINAL_ANSWER_LINE_RE` 保持同步。`missingFinalAnswer` reflection
// 规则镜像了此正则,使其接受/拒绝与本评分器实际评分的内容对称。
// 修改其中一处时,务必同步修改另一处。
const FINAL_ANSWER_RE = /\bFINAL\s*ANSWER\s*[:-]?\s*([\s\S]+?)\s*$/i;

// 模型有时会用 markdown / 代码标记包裹答案(例如
// `FINAL ANSWER: **green, white**`)。从提取值的两端剥除这些标记。
// 只处理外层包裹 —— 内部 markdown 保持不动,以免破坏那些合法包含
// `*` 或 `_` 的答案。
const SURROUNDING_MARKDOWN_LEAD_RE = /^(\*{1,2}|_{1,2}|`)+/;
const SURROUNDING_MARKDOWN_TAIL_RE = /(\*{1,2}|_{1,2}|`)+$/;

// 模型在叙述计划而非给出答案时使用的措辞。用于拒绝诸如
// "Let me try searching via DuckDuckGo…" 之类的回退捕获 —— 这些是
// 模型从未发出 FINAL ANSWER 时泄漏出来的思考文本。
const THINKING_PREFIX_RE =
  /^(let me|let's|now i|now let|i'll|i will|i need|i'm going|first,|next,|then,|the markdown)\b/i;

/**
 * 从 agent 的最后一段文本中提取 "FINAL ANSWER: ..."。
 *
 * GAIA 推荐的协议是 agent 每次回复都以该哨兵结尾;我们交给 agent
 * 的系统提示明确说明了这一点。该正则容忍尾随标点 / 引号,并接受
 * agent 偶尔混入的几种常见变体。
 *
 * 返回提取出的原始字符串(不做归一化 —— 交由 `scoreAnswer` 统一处理)。
 */
export const extractFinalAnswer = (agentText: string): string | null => {
  if (!agentText || agentText.trim().length === 0) return null;
  // 从消息末尾向前搜索 —— 协议规定它是 agent 说的最后一句,而许多
  // 模型在出声推理时会更早地重复该短语。
  const lines = agentText.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(FINAL_ANSWER_RE);
    if (m) {
      return m[1]
        .replace(/^["']|["']$/g, "")
        .trim()
        .replace(SURROUNDING_MARKDOWN_LEAD_RE, "")
        .replace(SURROUNDING_MARKDOWN_TAIL_RE, "")
        .trim();
    }
  }
  // 回退:取回复中最后一个非空行。当该行明显是模型在叙述下一步
  // 动作而非给出答案时予以拒绝 —— 返回 null 比在失败报告中把思考
  // 文本当作(错误)答案更干净。
  const tail = lines.reverse().find((l) => l.trim().length > 0);
  if (!tail) return null;
  const trimmed = tail.trim();
  if (THINKING_PREFIX_RE.test(trimmed)) return null;
  return trimmed;
};

// ─── 聚合辅助函数 ─────────────────────────────────────────────

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

/**
 * 按 level 对题目分组,用于 `byLevel` 汇总统计。即使某个 level 没有
 * 题目也返回计数,以便下游代码渲染出稳定的结构。
 */
export const groupByLevel = (
  questions: NormalizedQuestion[],
): Record<GaiaLevel, NormalizedQuestion[]> => {
  const out: Record<GaiaLevel, NormalizedQuestion[]> = { 1: [], 2: [], 3: [] };
  for (const q of questions) out[q.level].push(q);
  return out;
};
