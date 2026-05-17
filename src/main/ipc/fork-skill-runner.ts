/**
 * Fork-mode skill runner.
 *
 * The runtime half of `skills-runtime/executor.ts:executeSubagent` after
 * the M2 PR 3 migration. Owns:
 *   - per-call `LocalWorkspace` + `ToolRegistry` (built via `buildAgentToolRegistry`)
 *   - the same `beforeToolCall` approval hook the main agent path uses
 *   - an `AgentLoop` instance, with its own `AbortController` linked to
 *     the parent's signal so aborts propagate cleanly
 *   - IPC translation onto the existing `ai:stream-*` channels (delta,
 *     tool-call, tool-result, retry, error). DOES NOT emit `ai:stream-done`
 *     — that stays with the parent (`ai-handlers.ts:376`).
 *
 * Skills-runtime's `executeSubagent` calls into this via the new
 * `ExecutorDeps.runSubagent` callback. That keeps skills-runtime free of
 * IPC / Electron / AgentLoop concerns.
 */

import type { ModelMessage } from "ai";
import type { WebContents } from "electron";

import { DeltaBatcher } from "../ai/delta-batcher";
import { classifyError } from "../ai/error-classifier";
import { appendPattern } from "../ai/pattern-store";
import { StreamWatchdog } from "../ai/stream-watchdog";
import { AgentLoop } from "../core/agent/agent-loop";
import type { ClassifiedRetryError } from "../core/agent/retry";
import {
  buildReport,
  DEFAULT_SUB_AGENT_MAX_TOKENS,
  DEFAULT_SUB_AGENT_MAX_WALL_MS,
  extractJsonArtifacts,
  type SubAgentContract,
  type SubAgentReport,
  type SubAgentStatus,
} from "../core/agent/sub-agent-contract";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import { buildAgentToolRegistry } from "./agent-tools";
import { getModelAndAdapterByConfigId } from "./ai-models";
import { buildApprovalHook } from "./approval-hook";

export interface ForkSkillRunnerDeps {
  sender: WebContents;
  taskId: string;
  parentSignal: AbortSignal;
  workspacePath: string;
  /** Used as fallback when the skill's `model` frontmatter override fails. */
  llmConfigId?: string;
}

export interface RunSubagentOptions {
  /** Already wrapped with `wrapWithSecurityBoundary` by skills-runtime. */
  systemPrompt: string;
  workspacePath: string;
  /** User-facing prompt — fed into AgentLoop as the new turn. */
  prompt: string;
  history?: ModelMessage[];
  /** Skill frontmatter `allowed-tools` list. Empty/undefined → zero tools. */
  allowedTools?: string[];
  /** Skill frontmatter `model` override. Falls back to llmConfigId on failure. */
  modelOverrideId?: string;
  /** Override the per-turn step cap (default 20). */
  maxStepsPerTurn?: number;
  /**
   * Sub-agent contract. When supplied, output format / termination cap
   * the runner. When omitted, defaults to a free-form summary run so
   * legacy fork-skill callers continue to work.
   */
  contract?: SubAgentContract;
}

export type RunSubagentFn = (
  opts: RunSubagentOptions,
) => Promise<SubAgentReport>;

const fallbackContract = (prompt: string): SubAgentContract => ({
  goal: "sub-agent run",
  input: { prompt },
  output: { format: "summary" },
  termination: {},
});

/**
 * Char-based summary fallback. Token-accurate summarization is a
 * phase-2 concern — for MVP we cap at ~4 chars per token so the
 * report stays in budget without an extra LLM call.
 */
const truncateForSummary = (text: string, maxTokens: number): string => {
  const charCap = maxTokens * 4;
  if (text.length <= charCap) return text;
  return `${text.slice(0, charCap)}... [summary truncated]`;
};

/**
 * Build a `runSubagent` callback bound to the active task. Each invocation
 * resolves model/adapter, constructs the AgentLoop, and translates events
 * back to the renderer over the existing IPC channels.
 */
export const createForkSkillRunner = (
  deps: ForkSkillRunnerDeps,
): RunSubagentFn => {
  const { sender, taskId, parentSignal, llmConfigId } = deps;

  return async (opts) => {
    const startTime = Date.now();
    const effectiveContract = opts.contract ?? fallbackContract(opts.prompt);
    // ── Resolve model + adapter ─────────────────────────────────────
    let resolved: ReturnType<typeof getModelAndAdapterByConfigId>;
    if (opts.modelOverrideId) {
      try {
        resolved = getModelAndAdapterByConfigId(opts.modelOverrideId);
      } catch (err) {
        console.warn(
          `[fork-skill-runner] Model override "${opts.modelOverrideId}" failed; falling back to default:`,
          err instanceof Error ? err.message : err,
        );
        resolved = getModelAndAdapterByConfigId(llmConfigId);
      }
    } else {
      resolved = getModelAndAdapterByConfigId(llmConfigId);
    }
    const { model, adapter } = resolved;

    // ── Per-call pieces ─────────────────────────────────────────────
    const workspace = new LocalWorkspace(opts.workspacePath);
    // Force [] when undefined so the registry's allow() filter (zero-tool
    // default) matches the legacy `executor.ts:395-397` behavior.
    const toolRegistry = buildAgentToolRegistry({
      sender,
      taskId,
      workspace,
      allowedTools: opts.allowedTools ?? [],
    });
    const beforeToolCall = buildApprovalHook({ sender, taskId });

    // Child AbortController so the runner can react to its own
    // failures without aborting the parent. Forward parent abort once.
    const childController = new AbortController();
    const onParentAbort = () => {
      if (!childController.signal.aborted) childController.abort();
    };
    if (parentSignal.aborted) {
      childController.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    // Wall-clock guard. Unbounded by default for legacy callers; armed
    // only when the contract opts in (explicit maxWallMs > 0, or any
    // contract supplied — in which case the default kicks in).
    let timedOut = false;
    const rawWallMs = effectiveContract.termination.maxWallMs;
    const effectiveWallMs =
      typeof rawWallMs === "number" && rawWallMs > 0
        ? rawWallMs
        : opts.contract && rawWallMs === undefined
          ? DEFAULT_SUB_AGENT_MAX_WALL_MS
          : undefined;
    const wallTimer = effectiveWallMs
      ? setTimeout(() => {
          if (!childController.signal.aborted) {
            timedOut = true;
            childController.abort();
          }
        }, effectiveWallMs)
      : undefined;

    const deltaBatcher = new DeltaBatcher({
      flush: (text) => {
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-delta", { id: taskId, delta: text });
        }
      },
    });

    const watchdog = new StreamWatchdog({
      taskId,
      sender,
      abortController: childController,
    });
    watchdog.start();

    const registryTools = toolRegistry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace,
        signal: childController.signal,
        toolCallId,
      }),
      beforeToolCall,
    });

    const agentLoop = new AgentLoop({
      workspace,
      model,
      tools: registryTools,
      systemPrompt: `${opts.systemPrompt}\n\nCurrent workspace: ${opts.workspacePath}`,
      history: opts.history,
      providerOptions: adapter.buildProviderOptions(),
      signal: childController.signal,
      agentId: taskId,
      maxStepsPerTurn:
        effectiveContract.termination.maxTurns ?? opts.maxStepsPerTurn ?? 20,
      classifyError: (err): ClassifiedRetryError => {
        const c = classifyError(err);
        return {
          type: c.type,
          retryable: c.retryable,
          maxRetries: c.maxRetries,
          backoffMs: c.backoffMs,
        };
      },
    });

    // Aggregators that feed buildReport at agent_end.
    let toolCallCount = 0;
    let finalTextAccum = "";
    let endEventStatus: "completed" | "failed" | "cancelled" = "completed";
    let endEventError: string | undefined;
    let endEventUsage:
      | { inputTokens?: number | null; outputTokens?: number | null }
      | undefined;

    try {
      for await (const ev of agentLoop.run(opts.prompt)) {
        if (sender.isDestroyed()) break;

        switch (ev.type) {
          case "agent_start":
            // ai:stream-start is the parent's responsibility (parity with
            // the main agent path).
            break;
          case "message_update":
            watchdog.activity();
            deltaBatcher.push(ev.deltaText);
            break;
          case "tool_execution_start":
            deltaBatcher.drain();
            toolCallCount++;
            sender.send("ai:stream-tool-call", {
              id: taskId,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              args: ev.args,
            });
            break;
          case "tool_execution_end":
            sender.send("ai:stream-tool-result", {
              id: taskId,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              result: ev.result,
            });
            break;
          case "retry": {
            const retryInfo = classifyError(new Error(ev.errorType));
            sender.send("ai:stream-retry", {
              id: taskId,
              attempt: ev.attempt,
              type: ev.errorType,
              maxRetries: retryInfo.maxRetries,
            });
            break;
          }
          case "agent_end": {
            deltaBatcher.drain();
            endEventStatus = ev.status;
            endEventError = ev.error?.message;
            endEventUsage = ev.totalUsage as typeof endEventUsage;
            finalTextAccum = ev.finalText ?? "";
            if (ev.status === "failed") {
              const cls = classifyError(
                new Error(ev.error?.message ?? "Subagent failed"),
              );
              const errorMsg =
                cls.userMessage ?? ev.error?.message ?? "Unknown error";
              if (!sender.isDestroyed()) {
                sender.send("ai:stream-error", {
                  id: taskId,
                  error: errorMsg,
                  type: cls.type,
                  recoveryActions: cls.recoveryActions,
                });
              }
            }
            // Both completed / cancelled / failed fall through to the
            // report-building tail below. Parent still owns ai:stream-done.
            break;
          }
        }
      }
    } finally {
      deltaBatcher.drain();
      watchdog.stop();
      parentSignal.removeEventListener("abort", onParentAbort);
      if (wallTimer) clearTimeout(wallTimer);
    }

    // ── Build the SubAgentReport ───────────────────────────────────
    const AGENT_END_TO_REPORT_STATUS: Record<
      typeof endEventStatus,
      SubAgentStatus
    > = {
      completed: "ok",
      cancelled: "cancelled",
      failed: "failed",
    };
    const reportStatus: SubAgentStatus = timedOut
      ? "timeout"
      : AGENT_END_TO_REPORT_STATUS[endEventStatus];

    const maxTokens =
      effectiveContract.output.maxTokens ?? DEFAULT_SUB_AGENT_MAX_TOKENS;
    const precomputedSummary =
      effectiveContract.output.format === "summary"
        ? truncateForSummary(finalTextAccum, maxTokens)
        : undefined;

    const candidateArtifacts =
      reportStatus === "ok" && effectiveContract.output.format === "json"
        ? extractJsonArtifacts(finalTextAccum)
        : undefined;

    const report = buildReport({
      agentId: taskId,
      contract: effectiveContract,
      status: reportStatus,
      finalText: finalTextAccum,
      usage: endEventUsage
        ? {
            inputTokens: endEventUsage.inputTokens ?? null,
            outputTokens: endEventUsage.outputTokens ?? null,
            totalTokens:
              (endEventUsage.inputTokens ?? 0) +
                (endEventUsage.outputTokens ?? 0) || null,
          }
        : undefined,
      toolCallCount,
      durationMs: Date.now() - startTime,
      candidateArtifacts,
      precomputedSummary,
      error: endEventError,
    });

    // Fire-and-forget capture for the iterative-optimization layer.
    // No-op when no store path has been configured (see pattern-store).
    void appendPattern({
      kind: "subagent",
      ts: new Date().toISOString(),
      agentId: report.agentId,
      contractGoal: effectiveContract.goal,
      status: report.status,
      summary: report.summary,
      toolCallCount: report.toolCallCount,
      durationMs: report.durationMs,
      error: report.error,
    });

    return report;
  };
};
