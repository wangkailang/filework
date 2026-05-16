/**
 * Shared HTTP response handling for MiniMax clients.
 *
 * Both image-client and video-client speak the same envelope:
 *   - HTTP status must be 2xx, otherwise we surface the body text.
 *   - The JSON body carries a `base_resp.status_code` — `0` means success;
 *     anything else is an upstream error that should propagate to the UI.
 *
 * Centralised so adding a new MiniMax endpoint (audio, voice clone…) is
 * one import instead of another copy of the same guard pair.
 */

import { MinimaxApiError } from "./types";

export const ensureOk = async (
  response: Response,
  endpoint: string,
): Promise<void> => {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new MinimaxApiError(
    `MiniMax ${endpoint} HTTP ${response.status}: ${text || response.statusText}`,
    -1,
    response.status,
  );
};

export const ensureZeroStatus = (
  base: { status_code?: number; status_msg?: string } | undefined,
  endpoint: string,
  httpStatus: number,
): void => {
  const code = base?.status_code ?? -1;
  if (code !== 0) {
    throw new MinimaxApiError(
      `MiniMax ${endpoint} failed (${code}): ${base?.status_msg || "unknown error"}`,
      code,
      httpStatus,
    );
  }
};
