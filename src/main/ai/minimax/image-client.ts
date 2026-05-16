/**
 * MiniMax Image Generation client.
 *
 * Thin wrapper around POST {baseUrl}/image_generation. Synchronous —
 * the API returns the rendered image URL(s) directly (no polling
 * required, unlike video generation).
 *
 * fetch is injected so callers can pass `proxyAwareFetch` (split-routing
 * via Mihomo/Clash etc.). Tests pass a mock to avoid the network.
 */

import { resolveMinimaxBaseUrl } from "./chat-base-url";
import { ensureOk, ensureZeroStatus } from "./fetch-utils";
import { MinimaxApiError, type MinimaxImageResponse } from "./types";

export interface GenerateImageInput {
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  prompt: string;
  /** Optional aspect ratio token MiniMax accepts (e.g. "1:1", "16:9"). */
  aspectRatio?: string;
  /** Number of images to generate. Defaults to 1 to match UI expectations. */
  n?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface GenerateImageResult {
  /** URLs returned by MiniMax — short-lived; download promptly. */
  imageUrls: string[];
  /** Server-side request id, for support tickets. */
  requestId?: string;
}

export const generateImage = async (
  input: GenerateImageInput,
): Promise<GenerateImageResult> => {
  const fetchFn = input.fetchImpl ?? fetch;
  const baseUrl = resolveMinimaxBaseUrl(input.baseUrl);
  const url = `${baseUrl}/image_generation`;

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    response_format: "url",
    n: input.n ?? 1,
  };
  if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  await ensureOk(response, "image_generation");

  const json = (await response.json()) as MinimaxImageResponse;
  ensureZeroStatus(json.base_resp, "image_generation", response.status);

  const urls = json.data?.image_urls ?? [];
  if (urls.length === 0) {
    throw new MinimaxApiError(
      "MiniMax image_generation returned no image URLs",
      0,
      response.status,
    );
  }

  return { imageUrls: urls, requestId: json.id };
};
