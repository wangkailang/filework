import {
  resolveOpenAICompatibleBaseUrl,
  resolveOpenAICompatibleChatCompletionsUrl,
} from "../ai/adapters/openai-compatible-url";
import { resolveMinimaxBaseUrl } from "../ai/minimax/chat-base-url";
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

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
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

function readSuccessfulMediaProbeError(
  config: LlmConnectionConfig,
  body: string,
): string | null {
  if (config.provider !== "minimax" || config.modality === "chat") return null;
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as {
      base_resp?: {
        status_code?: number;
        status_msg?: string;
      };
    };
    const code = parsed.base_resp?.status_code;
    if (typeof code !== "number" || code === 0) return null;
    return `MiniMax media probe failed (${code}): ${
      parsed.base_resp?.status_msg || "unknown error"
    }`;
  } catch {
    return null;
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

function buildOpenAICompatibleImageRequest(config: LlmConnectionConfig): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
} {
  const baseUrl = config.baseUrl || defaultBaseUrlForProvider(config.provider);
  const resolvedBaseUrl = resolveOpenAICompatibleBaseUrl(
    baseUrl,
    config.apiPath,
  );
  if (!resolvedBaseUrl) {
    throw new Error("baseUrl is required");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return {
    url: `${trimTrailingSlashes(resolvedBaseUrl)}/images/generations`,
    headers,
    body: {
      model: config.model,
      n: 1,
      prompt: "ping",
    },
  };
}

function buildMinimaxMediaRequest(
  config: LlmConnectionConfig,
  modality: "image" | "video",
): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
} {
  const baseUrl = resolveMinimaxBaseUrl(config.baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return {
    url: `${baseUrl}/${modality === "image" ? "image_generation" : "video_generation"}`,
    headers,
    body:
      modality === "image"
        ? {
            model: config.model,
            n: 1,
            prompt: "ping",
            response_format: "url",
          }
        : {
            model: config.model,
            prompt: "ping",
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
  if (config.modality === "image") {
    if (config.provider === "minimax") {
      return buildMinimaxMediaRequest(config, "image");
    }
    if (config.provider === "custom" || config.provider === "openai") {
      return buildOpenAICompatibleImageRequest(config);
    }
    throw new Error(
      `Connection test does not support ${config.provider} image models`,
    );
  }

  if (config.modality === "video") {
    if (config.provider === "minimax") {
      return buildMinimaxMediaRequest(config, "video");
    }
    throw new Error(
      `Connection test does not support ${config.provider} video models`,
    );
  }

  if (config.provider === "anthropic") {
    return buildAnthropicRequest(config);
  }
  return buildOpenAICompatibleRequest(config);
}

export async function testLlmConfigConnection(
  config: LlmConnectionConfig,
  fetchImpl: FetchLike = getProviderFetch() as FetchLike,
): Promise<LlmConnectionTestResult> {
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
    const responseText = await response.text();
    const diagnostics: LlmConnectionDiagnostics = {
      ...baseDiagnostics,
      durationMs: Math.max(0, Date.now() - startedAt),
      statusCode: response.status,
    };

    if (response.ok) {
      const mediaProbeError = readSuccessfulMediaProbeError(
        config,
        responseText,
      );
      if (mediaProbeError) {
        return { status: "error", message: mediaProbeError, diagnostics };
      }
      return { status: "success", message: "Connection OK", diagnostics };
    }

    return {
      status: "error",
      message: readProviderErrorMessage(response.status, responseText),
      diagnostics,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
