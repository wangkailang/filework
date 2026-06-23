import { resolveOpenAICompatibleBaseUrl } from "../ai/adapters/openai-compatible-url";
import { getProviderFetch } from "../ai/provider-fetch";

type FetchLike = typeof fetch;

export interface LlmModelCapabilities {
  preferredApi: "chat_completions" | "responses";
  supportsReasoning: boolean | null;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
}

export interface LlmModelOption {
  capabilities: LlmModelCapabilities;
  contextWindow: number | null;
  value: string;
  label: string;
  maxOutputTokens: number | null;
}

function defaultFetch(): FetchLike {
  return getProviderFetch() ?? globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 160)}`);
  }
}

function readFinitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readModelLimit(
  rawModel: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = readFinitePositiveNumber(rawModel[key]);
    if (value) return value;
  }
  const limit = rawModel.limit;
  if (isRecord(limit)) {
    for (const key of keys) {
      const value = readFinitePositiveNumber(limit[key]);
      if (value) return value;
    }
  }
  return null;
}

export function inferLlmModelCapabilities(
  modelId: string,
): LlmModelCapabilities {
  const lowerId = modelId.toLowerCase();
  const isGpt5 = lowerId.includes("gpt-5");
  const isMini = lowerId.includes("mini");
  const isReasoningModel =
    (isGpt5 && !isMini) || lowerId.includes("o1") || lowerId.includes("o3");

  return {
    preferredApi: isGpt5 && !isMini ? "responses" : "chat_completions",
    supportsReasoning: isReasoningModel ? true : null,
    supportsTools: true,
    supportsVision:
      lowerId.includes("vision") ||
      lowerId.includes("gpt-4o") ||
      lowerId.includes("gemini")
        ? true
        : null,
  };
}

function parseOpenAICompatibleModels(body: unknown): LlmModelOption[] {
  const rawModels = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : [];
  const seen = new Set<string>();
  const models: LlmModelOption[] = [];

  for (const rawModel of rawModels) {
    if (!isRecord(rawModel) || typeof rawModel.id !== "string") continue;
    const value = rawModel.id.trim();
    if (!value || seen.has(value)) continue;
    const label =
      typeof rawModel.name === "string" && rawModel.name.trim()
        ? rawModel.name.trim()
        : value;
    seen.add(value);
    models.push({
      value,
      label,
      capabilities: inferLlmModelCapabilities(value),
      contextWindow: readModelLimit(rawModel, ["context_window", "context"]),
      maxOutputTokens: readModelLimit(rawModel, [
        "max_output_tokens",
        "output",
      ]),
    });
  }

  return models;
}

export async function fetchOpenAICompatibleModels(
  input: {
    apiKey?: string | null;
    apiPath?: string | null;
    baseUrl?: string | null;
  },
  fetchImpl: FetchLike = defaultFetch(),
): Promise<LlmModelOption[]> {
  const baseUrl = resolveOpenAICompatibleBaseUrl(input.baseUrl, input.apiPath);
  if (!baseUrl) {
    throw new Error("baseUrl is required");
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.apiKey) {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers,
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const models = parseOpenAICompatibleModels(body);
  if (models.length === 0) {
    throw new Error("Model response is missing models");
  }
  return models;
}
