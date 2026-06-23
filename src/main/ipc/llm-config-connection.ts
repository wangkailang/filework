import { resolveOpenAICompatibleChatCompletionsUrl } from "../ai/adapters/openai-compatible-url";
import { getProviderFetch } from "../ai/provider-fetch";
import type { LlmConfig, LlmProvider } from "../db";

export type LlmConnectionTestStatus = "success" | "error";

export interface LlmConnectionTestResult {
  diagnostics?: LlmConnectionDiagnostics;
  status: LlmConnectionTestStatus;
  message: string;
}

export interface LlmConnectionDiagnostics {
  checkedAt: string;
  durationMs: number;
  method: "POST";
  model: string;
  provider: LlmProvider;
  statusCode: number | null;
  url: string;
}

type LlmConnectionConfig = Pick<
  LlmConfig,
  "apiKey" | "apiPath" | "baseUrl" | "modality" | "model" | "provider"
>;

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text">>;

const DEFAULT_OPENAI_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimaxi.com/v1",
  ollama: "http://localhost:11434/v1",
};

function defaultBaseUrlForProvider(provider: LlmProvider): string | null {
  return DEFAULT_OPENAI_BASE_URLS[provider] ?? null;
}

function readProviderErrorMessage(status: number, body: string): string {
  if (!body.trim()) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.message || parsed.message;
    return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
  } catch {
    return `HTTP ${status}: ${body.slice(0, 240)}`;
  }
}

function buildOpenAICompatibleRequest(config: LlmConnectionConfig): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
} {
  const baseUrl = config.baseUrl || defaultBaseUrlForProvider(config.provider);
  const url = resolveOpenAICompatibleChatCompletionsUrl(
    baseUrl,
    config.apiPath,
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (config.provider === "github-copilot") {
    headers["Editor-Version"] = "filework/0.1.0";
    headers["User-Agent"] = "Filework";
    headers["Copilot-Integration-Id"] = "vscode-chat";
  }
  return {
    url,
    headers,
    body: {
      model: config.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    },
  };
}

function buildAnthropicRequest(config: LlmConnectionConfig): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
} {
  const url = `${(config.baseUrl || "https://api.anthropic.com").replace(
    /\/+$/,
    "",
  )}/v1/messages`;
  return {
    url,
    headers: {
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "x-api-key": config.apiKey || "",
    },
    body: {
      model: config.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    },
  };
}

function buildConnectionRequest(config: LlmConnectionConfig) {
  if (config.provider === "anthropic") {
    return buildAnthropicRequest(config);
  }
  return buildOpenAICompatibleRequest(config);
}

export async function testLlmConfigConnection(
  config: LlmConnectionConfig,
  fetchImpl: FetchLike = getProviderFetch() as FetchLike,
): Promise<LlmConnectionTestResult> {
  if (config.modality !== "chat") {
    return {
      status: "error",
      message: "Connection test currently supports chat models only",
    };
  }

  try {
    const request = buildConnectionRequest(config);
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    const baseDiagnostics = {
      checkedAt,
      method: "POST" as const,
      model: config.model,
      provider: config.provider,
      url: request.url,
    };
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    const diagnostics: LlmConnectionDiagnostics = {
      ...baseDiagnostics,
      durationMs: Math.max(0, Date.now() - startedAt),
      statusCode: response.status,
    };

    if (response.ok) {
      return { status: "success", message: "Connection OK", diagnostics };
    }

    return {
      status: "error",
      message: readProviderErrorMessage(response.status, await response.text()),
      diagnostics,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
