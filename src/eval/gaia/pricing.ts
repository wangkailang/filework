/**
 * 用于 GAIA 成本核算的模型价格表。
 *
 * 价格单位为每百万 token 的美元数,取自各服务商在 PR 创建时的
 * 官方定价页。它们一定会漂移 —— 当某服务商重新调整价格档位时,
 * 需更新此表,或在汇总中将成本字段置为 `null`。
 *
 * 未知 / 未定价的模型会让 `calculateCost` 返回 `null`,以便
 * 下游调用方能区分"无法定价"与"$0"。
 */

import type { TokenUsage } from "./types";

export interface ModelPrice {
  /** 每百万输入 token 的美元价(未命中缓存)。 */
  inputUsdPerMTok: number;
  /** 每百万输出 token 的美元价。 */
  outputUsdPerMTok: number;
  /** 每百万缓存读取 token 的美元价。Anthropic / OpenAI 提示缓存。 */
  cacheReadUsdPerMTok?: number;
  /** 每百万缓存写入 token 的美元价。 */
  cacheWriteUsdPerMTok?: number;
}

/**
 * 剥除服务商特定的日期 / 区域后缀,使诸如
 * `claude-sonnet-4-6-20251022` 的配置映射到规范的 `claude-sonnet-4-6`
 * 条目,无需为每个带日期的快照维护一行。
 */
export const normalizeModelId = (id: string): string =>
  id
    // `-YYYYMMDD` 后缀
    .replace(/-(2\d{3}\d{4})$/i, "")
    // Anthropic `-latest` 别名
    .replace(/-latest$/i, "");

/**
 * 静态价格表。键为规范化(剥除日期)后的模型 id。
 * 当有新模型加入项目的适配器列表时,在此新增一行。
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze(
  {
    // Anthropic Claude 4.x 系列
    "claude-opus-4-7": {
      inputUsdPerMTok: 15,
      outputUsdPerMTok: 75,
      cacheReadUsdPerMTok: 1.5,
      cacheWriteUsdPerMTok: 18.75,
    },
    "claude-sonnet-4-6": {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadUsdPerMTok: 0.3,
      cacheWriteUsdPerMTok: 3.75,
    },
    "claude-sonnet-4-7": {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadUsdPerMTok: 0.3,
      cacheWriteUsdPerMTok: 3.75,
    },
    "claude-haiku-4-5": {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
    // OpenAI
    "gpt-4o": { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
    "gpt-4o-mini": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
    // DeepSeek
    "deepseek-chat": { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.28 },
    "deepseek-reasoner": { inputUsdPerMTok: 0.55, outputUsdPerMTok: 2.19 },
    // MiniMax
    "abab6.5s-chat": { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    "minimax-text-01": { inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    // Xiaomi MiMo V2.5 系列（2026-05-27 调价公告生效）。官方报价为 CNY，
    // 按 $1 ≈ ¥7 折算入表；漂移以后只需在此处调汇率：
    //   - V2.5-Pro：输入 ¥3 / 输出 ¥6 / 命中缓存 ¥0.025（per MTok）
    //   - V2.5：    输入 ¥1 / 输出 ¥2 / 命中缓存 ¥0.02 （per MTok）
    // V2.1-TTS 限时免费、V2 系列官方建议迁移到 V2.5，均未录入。
    // calculateCost() 只用 input/output 两个字段；cache 字段记录在此供
    // 未来按 cache 命中拆账时复用。MiMo 不区分 cache write（首次写入按
    // 普通 input 计费），故 cacheWriteUsdPerMTok 留空。
    "mimo-v2.5-pro": {
      inputUsdPerMTok: 0.43,
      outputUsdPerMTok: 0.86,
      cacheReadUsdPerMTok: 0.0036,
    },
    "mimo-v2.5": {
      inputUsdPerMTok: 0.14,
      outputUsdPerMTok: 0.29,
      cacheReadUsdPerMTok: 0.0029,
    },
  },
);

/**
 * 返回 `model` 对应的规范价格行,无对应条目时返回 `null`。
 * 适用于希望提示"该模型未定价 —— 请更新价格表"告警的工具。
 */
export const getModelPrice = (model: string): ModelPrice | null =>
  MODEL_PRICES[normalizeModelId(model)] ?? null;

/**
 * 计算单次 agent 运行的美元成本,使用基础的输入/输出定价
 * (不区分缓存差额 —— 调用方在 `TokenUsage` 中并未拆分出这些)。
 *
 * 当模型不在 `MODEL_PRICES` 中时返回 `null`,使 runner 可以记录
 * "未定价",而非错误地按 $0 计算。
 */
export const calculateCost = (
  model: string,
  usage: TokenUsage | undefined,
): number | null => {
  if (!usage) return null;
  const price = getModelPrice(model);
  if (!price) return null;
  const inputCost = (usage.input * price.inputUsdPerMTok) / 1_000_000;
  const outputCost = (usage.output * price.outputUsdPerMTok) / 1_000_000;
  return inputCost + outputCost;
};

/** 将成本数值格式化为便于人读的形式。将 `null` 视为 "—"。 */
export const formatCost = (usd: number | null | undefined): string => {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
};
