/**
 * OpenAI-compatible image generation client.
 *
 * GPT Image models return base64 image payloads from POST /images/generations.
 * We normalize those payloads to data URLs so the existing media-storage layer
 * can persist them with the same code path used by provider CDN URLs.
 */

import { resolveOpenAICompatibleBaseUrl } from "../adapters/openai-compatible-url";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, "");

export class OpenAICompatibleImageError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "OpenAICompatibleImageError";
    this.httpStatus = httpStatus;
  }
}

export interface GenerateOpenAICompatibleImageInput {
  apiKey?: string | null;
  baseUrl?: string | null;
  apiPath?: string | null;
  model: string;
  prompt: string;
  n?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface GenerateOpenAICompatibleImageResult {
  imageUrls: string[];
}

interface OpenAICompatibleImageResponse {
  data?: Array<{
    b64_json?: string | null;
    url?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

const resolveImagesGenerationsUrl = (
  baseUrl: string | null | undefined,
  apiPath: string | null | undefined,
): string => {
  const resolvedBaseUrl =
    resolveOpenAICompatibleBaseUrl(
      baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL,
      apiPath,
    ) ?? DEFAULT_OPENAI_BASE_URL;
  return `${trimTrailingSlashes(resolvedBaseUrl)}/images/generations`;
};

const toImageSource = (
  image: NonNullable<OpenAICompatibleImageResponse["data"]>[number],
): string | null => {
  const b64 = image.b64_json?.trim();
  if (b64) {
    return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  }
  return image.url?.trim() || null;
};

export const generateOpenAICompatibleImage = async (
  input: GenerateOpenAICompatibleImageInput,
): Promise<GenerateOpenAICompatibleImageResult> => {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = resolveImagesGenerationsUrl(input.baseUrl, input.apiPath);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = input.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      n: input.n ?? 1,
      prompt: input.prompt,
    }),
    signal: input.signal,
  });

  const json = (await response
    .json()
    .catch(() => null)) as OpenAICompatibleImageResponse | null;
  if (!response.ok) {
    throw new OpenAICompatibleImageError(
      `OpenAI-compatible image generation HTTP ${response.status}: ${
        json?.error?.message || response.statusText || "unknown error"
      }`,
      response.status,
    );
  }

  const imageUrls = (json?.data ?? [])
    .map(toImageSource)
    .filter((source): source is string => Boolean(source));
  if (imageUrls.length === 0) {
    throw new OpenAICompatibleImageError(
      "OpenAI-compatible image generation returned no images",
      response.status,
    );
  }

  return { imageUrls };
};
