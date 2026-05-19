/**
 * Xiaomi MiMo Provider Adapter
 *
 * Why a dedicated adapter (not just DeepSeek):
 *
 *   `@ai-sdk/deepseek` speaks the right wire protocol (`reasoning_content`
 *   on assistant messages, OpenAI-compatible Chat Completions). But its
 *   message converter drops `reasoning_content` from any assistant whose
 *   index is ≤ the last user message — DeepSeek-Reasoner only needs the
 *   latest reasoning, but Xiaomi MiMo returns 400 on the 2nd+ turn:
 *
 *     "The reasoning_content in the thinking mode must be passed back to the API."
 *
 * Fix: wrap the deepseek model with middleware that captures the original
 * prompt's reasoning per-assistant-turn into an AsyncLocalStorage store,
 * then a custom fetch reads that store and re-stamps `reasoning_content`
 * on every assistant message the deepseek converter blanked out. Result:
 * Xiaomi sees full reasoning history; DeepSeek code path is untouched.
 *
 * We keep using `createDeepSeek` under the hood (so streaming response
 * parsing, tool-call deltas, error handling all stay battle-tested) and
 * only patch the *outgoing* body. The middleware never mutates the
 * prompt — that would just lose to the deepseek converter again.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { type LanguageModel, wrapLanguageModel } from "ai";
import {
  type CacheMetrics,
  NO_CACHE_METRICS,
  NO_PROVIDER_OPTIONS,
  type ProviderAdapter,
  type ProviderConfig,
} from "./base";

// One reasoning string per assistant turn, in prompt order. Empty
// string means "no reasoning emitted for this turn" — leave the
// outgoing message alone.
type AssistantReasonings = readonly string[];

const reasoningStorage = new AsyncLocalStorage<AssistantReasonings>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AssistantContentPart {
  type: string;
  text?: string;
}

interface LanguageModelMessage {
  role: string;
  content: string | AssistantContentPart[];
}

/**
 * Walk an AI-SDK LanguageModelV3 prompt and collect, per assistant
 * message, the concatenated reasoning text. Indexes line up with the
 * assistant messages in the OUTGOING API body — which is what the fetch
 * patcher iterates over.
 */
function extractAssistantReasonings(
  prompt: readonly LanguageModelMessage[],
): string[] {
  const out: string[] = [];
  for (const msg of prompt) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      out.push("");
      continue;
    }
    let reasoning = "";
    for (const part of msg.content) {
      if (part.type === "reasoning" && typeof part.text === "string") {
        reasoning += part.text;
      }
    }
    out.push(reasoning);
  }
  return out;
}

interface XiaomiBody {
  messages?: Array<
    {
      role?: string;
      reasoning_content?: string;
    } & Record<string, unknown>
  >;
}

function patchOutgoingBody(bodyText: string): string {
  const reasonings = reasoningStorage.getStore();
  if (!reasonings || reasonings.length === 0) return bodyText;
  let body: XiaomiBody;
  try {
    body = JSON.parse(bodyText) as XiaomiBody;
  } catch {
    return bodyText;
  }
  if (!Array.isArray(body.messages)) return bodyText;
  let assistantIdx = 0;
  let mutated = false;
  for (const msg of body.messages) {
    if (msg.role !== "assistant") continue;
    const reasoning = reasonings[assistantIdx];
    assistantIdx++;
    if (!reasoning) continue;
    // Only stamp when deepseek's converter dropped it. Keep what the
    // converter wrote for the latest turn (it's the same data anyway).
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
      continue;
    }
    msg.reasoning_content = reasoning;
    mutated = true;
  }
  return mutated ? JSON.stringify(body) : bodyText;
}

function makeXiaomiFetch(): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!url.includes("/chat/completions") || !init?.body) {
      return fetch(input as RequestInfo, init);
    }
    let bodyText: string | undefined;
    if (typeof init.body === "string") {
      bodyText = init.body;
    } else if (init.body instanceof Uint8Array) {
      bodyText = new TextDecoder().decode(init.body);
    }
    if (bodyText === undefined) {
      return fetch(input as RequestInfo, init);
    }
    const patched = patchOutgoingBody(bodyText);
    if (patched === bodyText) {
      return fetch(input as RequestInfo, init);
    }
    return fetch(input as RequestInfo, { ...init, body: patched });
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class XiaomiAdapter implements ProviderAdapter {
  readonly name = "xiaomi";

  createModel(config: ProviderConfig): LanguageModel {
    const deepseek = createDeepSeek({
      apiKey: config.apiKey || "",
      baseURL: config.baseUrl || undefined,
      fetch: makeXiaomiFetch(),
    });
    const baseModel = deepseek(config.model);
    return wrapLanguageModel({
      model: baseModel,
      middleware: {
        specificationVersion: "v3",
        transformParams: async ({ params }) => {
          // Capture reasoning before deepseek's converter strips it.
          // Use enterWith so the surrounding async context (including
          // the nested fetch call inside doStream) sees the store.
          const reasonings = extractAssistantReasonings(
            (params.prompt ?? []) as LanguageModelMessage[],
          );
          reasoningStorage.enterWith(reasonings);
          return params;
        },
      },
    });
  }

  buildProviderOptions() {
    return NO_PROVIDER_OPTIONS;
  }

  extractCacheMetrics(
    _providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics {
    return NO_CACHE_METRICS;
  }
}

// ---------------------------------------------------------------------------
// Test helpers (not used in production)
// ---------------------------------------------------------------------------

export const _internal = {
  extractAssistantReasonings,
  patchOutgoingBody,
  reasoningStorage,
};
