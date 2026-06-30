import type { ModelMessage } from "ai";
import type { ProviderConfig } from "./adapters/base";
import { getProviderFetch } from "./provider-fetch";

const OPENAI_RESPONSES_INPUT_TOKENS_URL =
  "https://api.openai.com/v1/responses/input_tokens";

export type ProviderTokenCountResult = {
  accuracy: "actual";
  inputTokens: number;
  provider: "openai";
  source: "openai-responses-input-tokens";
};

type TextInputPart = { type: "input_text"; text: string };
type TextOutputPart = { type: "output_text"; text: string };
type OpenAIResponsesInputItem =
  | { role: "developer" | "system"; content: string }
  | { role: "user"; content: TextInputPart[] }
  | { role: "assistant"; content: TextOutputPart[] }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | Array<TextInputPart>;
    };

type OpenAIResponsesInput = OpenAIResponsesInputItem[];

export const supportsOpenAIResponsesInputTokenCount = (
  config: Pick<
    ProviderConfig,
    "apiKey" | "baseUrl" | "modelCapabilities" | "provider"
  >,
): boolean => {
  if (config.provider !== "openai") return false;
  if (!config.apiKey) return false;
  if (config.modelCapabilities?.preferredApi === "chat_completions") {
    return false;
  }
  return isOfficialOpenAIEndpoint(config.baseUrl);
};

export const countOpenAIResponsesInputTokens = async (
  config: Pick<
    ProviderConfig,
    "apiKey" | "baseUrl" | "model" | "modelCapabilities" | "provider"
  >,
  messages: ModelMessage[],
  options?: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<ProviderTokenCountResult | null> => {
  if (!supportsOpenAIResponsesInputTokenCount(config)) return null;

  const input = toOpenAIResponsesInput(messages);
  if (!input) return null;

  const fetchImpl = options?.fetch ?? getProviderFetch() ?? globalThis.fetch;
  if (!fetchImpl) return null;

  try {
    const response = await fetchImpl(OPENAI_RESPONSES_INPUT_TOKENS_URL, {
      body: JSON.stringify({ model: config.model, input }),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: options?.signal,
    });

    if (!response.ok) {
      console.warn(
        "[ProviderTokenCount] OpenAI input token count failed:",
        response.status,
        response.statusText,
      );
      return null;
    }

    const data = (await response.json()) as { input_tokens?: unknown };
    if (
      typeof data.input_tokens !== "number" ||
      !Number.isFinite(data.input_tokens)
    ) {
      console.warn(
        "[ProviderTokenCount] OpenAI input token count returned invalid payload",
      );
      return null;
    }

    return {
      accuracy: "actual",
      inputTokens: data.input_tokens,
      provider: "openai",
      source: "openai-responses-input-tokens",
    };
  } catch (error) {
    if ((error as { name?: string })?.name !== "AbortError") {
      console.warn(
        "[ProviderTokenCount] OpenAI input token count request failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return null;
  }
};

const isOfficialOpenAIEndpoint = (baseUrl: string | null | undefined) => {
  if (!baseUrl?.trim()) return true;
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
};

const toOpenAIResponsesInput = (
  messages: ModelMessage[],
): OpenAIResponsesInput | null => {
  const input: OpenAIResponsesInput = [];

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        if (typeof message.content !== "string") return null;
        input.push({ role: "developer", content: message.content });
        break;
      }
      case "user": {
        const content = toUserInputContent(message.content);
        if (!content) return null;
        input.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const ok = appendAssistantInput(input, message.content);
        if (!ok) return null;
        break;
      }
      case "tool": {
        const ok = appendToolInput(input, message.content);
        if (!ok) return null;
        break;
      }
      default:
        return null;
    }
  }

  return input;
};

const toUserInputContent = (content: unknown): TextInputPart[] | null => {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (!Array.isArray(content)) return null;

  const parts: TextInputPart[] = [];
  for (const part of content) {
    if (!isRecord(part)) return null;
    if (part.type !== "text" || typeof part.text !== "string") {
      return null;
    }
    parts.push({ type: "input_text", text: part.text });
  }
  return parts;
};

const appendAssistantInput = (
  input: OpenAIResponsesInput,
  content: unknown,
): boolean => {
  if (typeof content === "string") {
    if (content) {
      input.push({
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      });
    }
    return true;
  }
  if (!Array.isArray(content)) return false;

  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") return false;
    if (part.type === "text") {
      if (typeof part.text !== "string") return false;
      input.push({
        role: "assistant",
        content: [{ type: "output_text", text: part.text }],
      });
      continue;
    }
    if (part.type === "tool-call") {
      if (
        typeof part.toolCallId !== "string" ||
        typeof part.toolName !== "string"
      ) {
        return false;
      }
      input.push({
        type: "function_call",
        call_id: part.toolCallId,
        name: part.toolName,
        arguments: stringifyJson(part.input),
      });
      continue;
    }

    return false;
  }

  return true;
};

const appendToolInput = (
  input: OpenAIResponsesInput,
  content: unknown,
): boolean => {
  if (!Array.isArray(content)) return false;

  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-result") return false;
    if (typeof part.toolCallId !== "string") return false;
    const output = toToolOutput(part.output);
    if (output == null) return false;
    input.push({
      type: "function_call_output",
      call_id: part.toolCallId,
      output,
    });
  }

  return true;
};

const toToolOutput = (
  output: unknown,
): string | Array<TextInputPart> | null => {
  if (!isRecord(output) || typeof output.type !== "string") return null;
  switch (output.type) {
    case "text":
    case "error-text":
      return typeof output.value === "string" ? output.value : null;
    case "json":
    case "error-json":
      return stringifyJson(output.value);
    case "execution-denied":
      return typeof output.reason === "string"
        ? output.reason
        : "Tool execution denied.";
    case "content":
      if (!Array.isArray(output.value)) return null;
      return toToolContentOutput(output.value);
    default:
      return null;
  }
};

const toToolContentOutput = (value: unknown[]): Array<TextInputPart> | null => {
  const parts: TextInputPart[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (item.type !== "text" || typeof item.text !== "string") {
      return null;
    }
    parts.push({ type: "input_text", text: item.text });
  }
  return parts;
};

const stringifyJson = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object";
