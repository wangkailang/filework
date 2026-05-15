/**
 * MiniMax base-URL resolution.
 *
 * MiniMax runs two regional endpoints with identical API surface:
 *  - https://api.minimaxi.com/v1 (Mainland China, default)
 *  - https://api.minimax.io/v1   (International)
 *
 * Users can override per-config via the LLM config's `baseUrl` field
 * (e.g. a private gateway, or to flip regions). When unset we default to
 * Mainland — flip the default here if the international tier becomes
 * more common.
 */

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";

/** Normalize a base URL: strip trailing slash so callers can append "/..." safely. */
const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, "");

export const resolveMinimaxBaseUrl = (
  override: string | null | undefined,
): string => {
  const raw =
    override && override.trim() !== "" ? override : MINIMAX_DEFAULT_BASE_URL;
  return stripTrailingSlash(raw);
};
