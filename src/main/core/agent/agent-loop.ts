/**
 * AgentLoop — domain-neutral orchestrator that runs one model turn-set
 * via Vercel AI SDK's `streamText`, translates the `fullStream` into
 * typed `AgentEvent`s, and yields them as an async iterable.
 *
 * Replaces the inline `streamAndConsume` loop at
 * `src/main/ipc/ai-handlers.ts:476-568`. Behavior parity:
 * - Single `streamText` call wrapped in optional retry (per-turn granularity)
 * - `transformContext` hook for compaction (was inline at lines 243-305)
 * - `beforeToolCall` routes through ToolRegistry (PR 1) — no extra wiring here
 * - Cancellation via AbortSignal
 *
 * Note: AI-SDK `streamText` already loops up to `stepCountIs(N)` internal
 * steps. Each "step" is one model decision (text-only or text+tool-calls)
 * — we map step boundaries to PI-style turn events.
 */

import { randomUUID } from "node:crypto";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel, ModelMessage, Tool } from "ai";
import { stepCountIs, streamText } from "ai";

import type { Workspace } from "../workspace/types";
import type {
  AgentEndStatus,
  AgentEvent,
  ClassifiedAgentError,
  TokenUsage,
  TurnEndReason,
} from "./events";
import type { ErrorClassifier } from "./retry";
import { withRetry } from "./retry";
import type { BeforeToolCallHook, ToolContext } from "./tool-registry";
import { ToolRegistry } from "./tool-registry";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface TransformContextResult {
  messages: ModelMessage[];
  /** Optional metrics surfaced as a `context_compressed` event. */
  originalTokens?: number;
  compressedTokens?: number;
}

export type TransformContextHook = (
  messages: ModelMessage[],
  signal?: AbortSignal,
) => Promise<TransformContextResult>;

export interface AgentLoopHooks {
  beforeToolCall?: BeforeToolCallHook;
  transformContext?: TransformContextHook;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  workspace: Workspace;
  model: LanguageModel;
  /**
   * Tools available to the model. Pass either a `ToolRegistry` (which
   * AgentLoop will convert via `toAiSdkTools()` honoring the
   * `beforeToolCall` hook) or a pre-built ai-sdk `Record<string, Tool>`
   * (when the IPC layer wants to keep its existing approval-wrapped tools).
   */
  tools: ToolRegistry | Record<string, Tool>;
  systemPrompt: string;
  /** Existing conversation history. Excludes the new user prompt. */
  history?: ModelMessage[];
  hooks?: AgentLoopHooks;
  /** Hard cap on internal AI-SDK steps per `streamText` call. Default 20. */
  maxStepsPerTurn?: number;
  /** Provider-specific options merged into the streamText call. */
  providerOptions?: ProviderOptions;
  /** Caller-provided abort. Aborting cancels the run. */
  signal?: AbortSignal;
  /** Stable id used in event payloads. Auto-generated if absent. */
  agentId?: string;
  /** Optional error classifier to enable retry. Without it, no retries. */
  classifyError?: ErrorClassifier;
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  constructor(private readonly cfg: AgentLoopConfig) {}

  async *run(prompt: string): AsyncGenerator<AgentEvent, void, void> {
    const agentId = this.cfg.agentId ?? randomUUID();
    const queue: AgentEvent[] = [];
    let waiter: (() => void) | null = null;
    let producerDone = false;

    const emit = (e: AgentEvent) => {
      queue.push(e);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };

    const work = this.runProducer(agentId, prompt, emit).finally(() => {
      producerDone = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    });

    // Avoid uncaught rejection while consumer drains the queue.
    work.catch(() => {});

    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev !== undefined) yield ev;
      }
      if (producerDone) break;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    // Surface producer errors AFTER the queue has fully drained so the
    // consumer sees the final agent_end event before the throw.
    await work;
  }

  private async runProducer(
    agentId: string,
    prompt: string,
    emit: (e: AgentEvent) => void,
  ): Promise<void> {
    emit({
      type: "agent_start",
      agentId,
      prompt,
      timestamp: new Date().toISOString(),
    });

    let history = this.cfg.history ?? [];

    // ── transformContext hook ────────────────────────────────────────
    if (this.cfg.hooks?.transformContext) {
      try {
        const r = await this.cfg.hooks.transformContext(
          history,
          this.cfg.signal,
        );
        history = r.messages;
        if (
          typeof r.originalTokens === "number" &&
          typeof r.compressedTokens === "number"
        ) {
          emit({
            type: "context_compressed",
            agentId,
            originalTokens: r.originalTokens,
            compressedTokens: r.compressedTokens,
          });
        }
      } catch (err) {
        // Non-fatal: log and continue with raw history.
        console.warn(
          "[AgentLoop] transformContext hook failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const messages: ModelMessage[] = [
      ...history,
      { role: "user", content: prompt },
    ];

    const aiTools =
      this.cfg.tools instanceof ToolRegistry
        ? this.cfg.tools.toAiSdkTools({
            ctxFactory: ({ toolCallId }): ToolContext => ({
              workspace: this.cfg.workspace,
              signal: this.cfg.signal ?? new AbortController().signal,
              toolCallId,
            }),
            beforeToolCall: this.cfg.hooks?.beforeToolCall,
          })
        : this.cfg.tools;

    let totalUsage: TokenUsage | undefined;
    let providerMetadata: Record<string, unknown> | undefined;
    let finalTextAccum = "";

    const callStreamText = async () => {
      // Per-turn buffers — reset on retry.
      let turnIndex = -1;
      let messageId = "";
      let messageText = "";
      let messageOpen = false;

      const result = streamText({
        model: this.cfg.model,
        tools: aiTools,
        stopWhen: stepCountIs(this.cfg.maxStepsPerTurn ?? 20),
        system: this.cfg.systemPrompt,
        messages,
        abortSignal: this.cfg.signal,
        providerOptions: this.cfg.providerOptions,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step": {
            turnIndex++;
            messageId = `${agentId}:msg:${turnIndex}`;
            messageText = "";
            messageOpen = false;
            emit({ type: "turn_start", agentId, turnIndex });
            break;
          }
          case "text-delta": {
            const delta = part.text;
            if (!messageOpen) {
              messageOpen = true;
              emit({
                type: "message_start",
                agentId,
                messageId,
                role: "assistant",
              });
            }
            messageText += delta;
            emit({
              type: "message_update",
              agentId,
              messageId,
              deltaText: delta,
            });
            break;
          }
          case "tool-call": {
            emit({
              type: "tool_execution_start",
              agentId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.input,
            });
            break;
          }
          case "tool-result": {
            const out = part.output as { success?: boolean; denied?: boolean };
            const success = !(out && out.success === false);
            emit({
              type: "tool_execution_end",
              agentId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: part.output,
              success,
              durationMs: 0,
            });
            break;
          }
          case "finish-step": {
            if (messageOpen) {
              const stepUsage = mapUsage(part.usage);
              emit({
                type: "message_end",
                agentId,
                messageId,
                finalText: messageText,
                usage: stepUsage,
              });
              finalTextAccum += messageText;
              messageOpen = false;
            }
            emit({
              type: "turn_end",
              agentId,
              turnIndex,
              reason: mapTurnEndReason(part.finishReason),
            });
            break;
          }
          case "error": {
            throw part.error;
          }
        }
      }

      // Capture aggregated usage + provider metadata from the resolved
      // streamText handle. These are promises that settle once the stream
      // finishes consuming.
      try {
        const usage = await result.totalUsage;
        totalUsage = mapUsage(usage);
      } catch {
        // Non-critical
      }
      try {
        const meta = await result.providerMetadata;
        providerMetadata = meta as Record<string, unknown> | undefined;
      } catch {
        // Non-critical
      }
    };

    const onRetry = (attempt: number, errorType: string) => {
      // Reset accumulated text on retry — the assistant message restarts.
      finalTextAccum = "";
      emit({
        type: "retry",
        agentId,
        turnIndex: -1,
        attempt,
        errorType,
      });
    };

    try {
      await withRetry(callStreamText, {
        classify: this.cfg.classifyError,
        onRetry,
        signal: this.cfg.signal,
      });
      emit({
        type: "agent_end",
        agentId,
        status: "completed",
        totalUsage,
        providerMetadata,
        finalText: finalTextAccum,
      });
    } catch (err) {
      // Surface zod cause for AI SDK prompt-schema errors so a bad
      // message shape is debuggable from the main-process log. The
      // SDK wraps the ZodError two levels deep:
      // InvalidPromptError → TypeValidationError → ZodError.
      if (err instanceof Error && err.name === "AI_InvalidPromptError") {
        const c1 = (err as { cause?: unknown }).cause;
        const c2 = (c1 as { cause?: unknown } | undefined)?.cause;
        const issues = (c2 ?? c1) as { issues?: unknown } | undefined;
        console.error(
          "[agent-loop] AI SDK schema validation failed:",
          JSON.stringify(issues?.issues, null, 2),
        );
      }
      const status: AgentEndStatus =
        err instanceof Error && err.name === "AbortError"
          ? "cancelled"
          : "failed";
      const errorPayload: ClassifiedAgentError | undefined =
        status === "failed"
          ? {
              message: err instanceof Error ? err.message : String(err),
              type: "unknown",
            }
          : undefined;
      emit({
        type: "agent_end",
        agentId,
        status,
        error: errorPayload,
        totalUsage,
        providerMetadata,
        finalText: finalTextAccum,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
}

function mapUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as RawUsage;
  const input = u.inputTokens ?? null;
  const output = u.outputTokens ?? null;
  const total =
    u.totalTokens ??
    (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: u.cachedInputTokens ?? null,
  };
}

function mapTurnEndReason(reason: string | undefined): TurnEndReason {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "stop":
    case "length":
    case "content-filter":
      return "finish";
    default:
      return "stop";
  }
}
