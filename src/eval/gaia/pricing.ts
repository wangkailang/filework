/**
 * Model price table for GAIA cost accounting.
 *
 * Prices are USD per million tokens, taken from each provider's
 * official pricing page at PR-creation time. They WILL drift — when a
 * provider re-tiers, update this table or set the cost field to `null`
 * in summaries.
 *
 * Unknown / un-priced models return `null` from `calculateCost` so
 * downstream callers can distinguish "couldn't price" from "$0".
 */

import type { TokenUsage } from "./types";

export interface ModelPrice {
  /** USD per million input tokens (uncached). */
  inputUsdPerMTok: number;
  /** USD per million output tokens. */
  outputUsdPerMTok: number;
  /** USD per million cache-read tokens. Anthropic / OpenAI prompt cache. */
  cacheReadUsdPerMTok?: number;
  /** USD per million cache-write tokens. */
  cacheWriteUsdPerMTok?: number;
}

/**
 * Strip provider-specific date / region suffixes so configs like
 * `claude-sonnet-4-6-20251022` map to the canonical `claude-sonnet-4-6`
 * entry without us maintaining one row per dated snapshot.
 */
export const normalizeModelId = (id: string): string =>
  id
    // `-YYYYMMDD` suffix
    .replace(/-(2\d{3}\d{4})$/i, "")
    // Anthropic `-latest` alias
    .replace(/-latest$/i, "");

/**
 * Static price table. Keys are the canonical (date-stripped) model ids.
 * Add a row when a new model joins the project's adapter list.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze(
  {
    // Anthropic Claude 4.x
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
  },
);

/**
 * Returns the canonical price row for `model`, or `null` when we have
 * no entry. Useful for tooling that wants to surface "this model isn't
 * priced — update the table" warnings.
 */
export const getModelPrice = (model: string): ModelPrice | null =>
  MODEL_PRICES[normalizeModelId(model)] ?? null;

/**
 * Compute the USD cost of a single agent run, using the basic
 * input/output pricing (cache deltas not surfaced — caller doesn't
 * have those broken out in `TokenUsage`).
 *
 * Returns `null` when the model isn't in `MODEL_PRICES` so the runner
 * can record "unpriced" rather than miscalculate as $0.
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

/** Format a cost number for human display. Treats `null` as "—". */
export const formatCost = (usd: number | null | undefined): string => {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
};
