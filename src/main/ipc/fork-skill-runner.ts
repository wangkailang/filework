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
import { StreamWatchdog } from "../ai/stream-watchdog";
import { AgentLoop } from "../core/agent/agent-loop";
import type { ClassifiedRetryError } from "../core/agent/retry";
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
}

export type RunSubagentFn = (opts: RunSubagentOptions) => Promise<void>;

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
      maxStepsPerTurn: opts.maxStepsPerTurn ?? 20,
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
            // Both completed / cancelled / failed return without emitting
            // stream-done; the parent emits it after this promise resolves.
            return;
          }
        }
      }
    } finally {
      deltaBatcher.drain();
      watchdog.stop();
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  };
};
