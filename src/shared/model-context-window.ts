/**
 * Known model context windows, in tokens.
 *
 * Prefix matching lets dated model ids reuse the same metadata, e.g.
 * `claude-3.5-sonnet-20241022` matches `claude-3.5-sonnet`.
 */
const MODEL_CONTEXT_WINDOWS: [prefix: string, tokens: number][] = [
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-3.7", 200_000],
  ["claude-3.5-sonnet", 200_000],
  ["claude-3.5-haiku", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-3-sonnet", 200_000],
  ["claude-3-haiku", 200_000],
  ["claude", 200_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4-0125", 128_000],
  ["gpt-4-1106", 128_000],
  ["gpt-4", 8_192],
  ["gpt-3.5-turbo", 16_385],
  ["gpt-5.5", 1_050_000],
  ["o4-mini", 200_000],
  ["o3", 200_000],
  ["o3-mini", 200_000],
  ["o1", 200_000],
  ["o1-mini", 128_000],
  ["deepseek-chat", 64_000],
  ["deepseek-coder", 64_000],
  ["deepseek-reasoner", 64_000],
  ["deepseek", 64_000],
  ["mimo-v2.5", 128_000],
  ["mimo", 128_000],
];

export function getContextWindowForModelId(
  modelId: string | null | undefined,
): number | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  for (const [prefix, contextWindow] of MODEL_CONTEXT_WINDOWS) {
    if (lower.startsWith(prefix)) return contextWindow;
  }
  return null;
}
