export interface KnownModelLimits {
  contextWindow: number;
  maxOutputTokens?: number;
}

/**
 * Known model limits, in tokens.
 *
 * Prefix matching lets dated model ids reuse the same metadata, e.g.
 * `claude-3.5-sonnet-20241022` matches `claude-3.5-sonnet`. More specific
 * prefixes must appear before provider-family fallbacks.
 */
const MODEL_LIMITS: [prefix: string, limits: KnownModelLimits][] = [
  ["claude-opus-4", { contextWindow: 200_000 }],
  ["claude-sonnet-4", { contextWindow: 200_000 }],
  ["claude-3.7", { contextWindow: 200_000 }],
  ["claude-3.5-sonnet", { contextWindow: 200_000 }],
  ["claude-3.5-haiku", { contextWindow: 200_000 }],
  ["claude-3-opus", { contextWindow: 200_000 }],
  ["claude-3-sonnet", { contextWindow: 200_000 }],
  ["claude-3-haiku", { contextWindow: 200_000 }],
  ["claude", { contextWindow: 200_000 }],
  ["gpt-4.1", { contextWindow: 1_000_000 }],
  ["gpt-4o", { contextWindow: 128_000 }],
  ["gpt-4-turbo", { contextWindow: 128_000 }],
  ["gpt-4-0125", { contextWindow: 128_000 }],
  ["gpt-4-1106", { contextWindow: 128_000 }],
  ["gpt-4", { contextWindow: 8_192 }],
  ["gpt-3.5-turbo", { contextWindow: 16_385 }],
  ["gpt-5.5", { contextWindow: 1_050_000 }],
  ["o4-mini", { contextWindow: 200_000 }],
  ["o3", { contextWindow: 200_000 }],
  ["o3-mini", { contextWindow: 200_000 }],
  ["o1", { contextWindow: 200_000 }],
  ["o1-mini", { contextWindow: 128_000 }],
  ["deepseek-v4-pro", { contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  ["deepseek-v4-flash", { contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  // Official aliases currently route to V4 Flash. Keep explicit entries ahead
  // of the legacy family fallback so active configurations get correct limits.
  ["deepseek-chat", { contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  ["deepseek-reasoner", { contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  ["deepseek-coder", { contextWindow: 64_000 }],
  ["deepseek", { contextWindow: 64_000 }],
  ["mimo-v2.5", { contextWindow: 128_000 }],
  ["mimo", { contextWindow: 128_000 }],
];

export function getKnownModelLimitsForModelId(
  modelId: string | null | undefined,
): KnownModelLimits | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  for (const [prefix, limits] of MODEL_LIMITS) {
    if (lower.startsWith(prefix)) return { ...limits };
  }
  return null;
}

export function getContextWindowForModelId(
  modelId: string | null | undefined,
): number | null {
  return getKnownModelLimitsForModelId(modelId)?.contextWindow ?? null;
}
