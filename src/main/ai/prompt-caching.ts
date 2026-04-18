/**
 * Prompt Caching for Anthropic Models
 *
 * Applies cache_control breakpoints to reduce input token costs by ~75%
 * on multi-turn conversations. Uses the Vercel AI SDK's providerOptions
 * for Anthropic's ephemeral caching.
 *
 * Inspired by Hermes Agent's prompt_caching.py.
 */

/**
 * Build Anthropic-specific provider options with prompt caching enabled.
 *
 * Returns an empty object for non-Anthropic providers (no-op).
 * For Anthropic, enables ephemeral cache control which caches the system
 * prompt and conversation prefix, reducing input token costs on subsequent turns.
 */
type JSONValue = null | string | number | boolean | JSONObject | JSONValue[];
type JSONObject = { [key: string]: JSONValue };

export function buildProviderOptions(
  provider: string,
): Record<string, JSONObject> {
  if (provider !== "anthropic") {
    return {};
  }

  return {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
  };
}
