/**
 * AI Handlers - Main IPC Handler Registration
 *
 * Orchestrates AI-related IPC handlers and task execution.
 * This is the refactored, smaller main handler file.
 */

import crypto from "node:crypto";
import { ipcMain } from "electron";
import { compressContext } from "../ai/context-compressor";
import { DeltaBatcher } from "../ai/delta-batcher";
import { classifyError } from "../ai/error-classifier";
import { emitMemoryEvent } from "../ai/memory-debug-store";
import {
  convertToCoreMessages,
  type HistoryMessage,
} from "../ai/message-converter";
import { appendPattern } from "../ai/pattern-store";
import { summarizeLargeToolResults } from "../ai/result-summarizer";
import { StreamWatchdog } from "../ai/stream-watchdog";
import { emitTaskTraceEvent } from "../ai/task-trace-store";
import {
  estimateTokens,
  getTokenBudgetForModel,
  truncateToFitAsync,
} from "../ai/token-budget";
import { AgentLoop } from "../core/agent/agent-loop";
import type { AgentEvent } from "../core/agent/events";
import {
  builtinRules,
  createReflectionGate,
  defaultRules,
} from "../core/agent/reflection-gate";
import type { ClassifiedRetryError } from "../core/agent/retry";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import {
  createWorkspace,
  type WorkspaceFactoryDeps,
} from "../core/workspace/workspace-factory";
import { decodeRef, type WorkspaceRef } from "../core/workspace/workspace-ref";
import {
  addTask,
  getDefaultLlmConfig,
  getLlmConfig,
  getSetting,
  setSetting,
  updateTask,
} from "../db";
import { getAllSuggestions, skillRegistry, skills } from "../skills";
import type { ExecutorDeps } from "../skills-runtime";
import {
  executeSkill,
  getTrustLevel,
  initSkillDiscovery,
  preprocessSkill,
  wrapWithSecurityBoundary,
} from "../skills-runtime";
import type { UnifiedSkill } from "../skills-runtime/types";
import { buildAgentToolRegistry } from "./agent-tools";
import { getModelAndAdapterByConfigId } from "./ai-models";
import { registerPlanHandlers } from "./ai-plan-handlers";
import {
  abortControllers,
  cleanupTask,
  manualStopFlags,
  pendingApprovals,
  setTaskWorkspace,
  stopTaskExecution,
  toolCallToTaskMap,
} from "./ai-task-control";
import { settleBatch } from "./approval-batcher";
import { buildApprovalHook } from "./approval-hook";
import { createForkSkillRunner } from "./fork-skill-runner";
import { registerMemoryDebugHandlers } from "./memory-debug-handlers";
import { buildAgentSystemPrompt } from "./system-prompt";
import { registerUsageHandlers } from "./usage-handlers";

// buildSystemPrompt extracted to ./system-prompt.ts (M2 PR 2 — domain-neutral).

/**
 * Resolve a task payload's workspace ref. Backward compat: if the
 * renderer only sent `workspacePath` (legacy), treat it as a local ref.
 */
const resolveWorkspaceRef = (payload: {
  workspaceRefJson?: string;
  workspacePath?: string;
}): WorkspaceRef => {
  if (payload.workspaceRefJson) {
    const ref = decodeRef(payload.workspaceRefJson);
    if (ref) return ref;
  }
  if (payload.workspacePath) {
    return { kind: "local", path: payload.workspacePath };
  }
  throw new Error("Task payload missing workspaceRefJson or workspacePath");
};

let workspaceFactoryDeps: WorkspaceFactoryDeps | null = null;

/** Wire workspace factory deps once during main bootstrap. */
export const setWorkspaceFactoryDeps = (deps: WorkspaceFactoryDeps): void => {
  workspaceFactoryDeps = deps;
};

const requireWorkspaceFactoryDeps = (): WorkspaceFactoryDeps => {
  if (!workspaceFactoryDeps) {
    throw new Error(
      "workspace factory deps not registered — call setWorkspaceFactoryDeps() during bootstrap",
    );
  }
  return workspaceFactoryDeps;
};

/**
 * Main task execution handler
 */
const handleTaskExecution = async (
  event: Electron.IpcMainInvokeEvent,
  payload: {
    prompt: string;
    /** Encoded WorkspaceRef (preferred). Falls back to workspacePath. */
    workspaceRefJson?: string;
    /** Legacy: absolute path. Treated as `{kind:"local", path}`. */
    workspacePath?: string;
    /**
     * Chat session id. Used as the per-session scope for github
     * auto-branching (`claude/<sessionId.slice(0,8)>`). When absent
     * (skills, tests, ad-hoc invocations), the workspace falls back to
     * a ref-derived stable scope.
     */
    sessionId?: string;
    llmConfigId?: string;
    history?: Array<{ role: string; content: string; parts?: unknown[] }>;
  },
) => {
  const ref = resolveWorkspaceRef(payload);
  // For sandbox + skill discovery we need a concrete on-disk path. For
  // local refs that's just `ref.path`; for github it's the clone dir,
  // which we won't know until we materialize the Workspace below.
  const legacyWorkspacePath =
    ref.kind === "local" ? ref.path : (payload.workspacePath ?? "");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const taskStartMs = Date.now();
  const sender = event.sender;

  addTask({
    id,
    workspaceId: "default",
    prompt: payload.prompt,
    status: "running",
    result: null,
    filesAffected: null,
    createdAt: now,
    completedAt: null,
  });

  const controller = new AbortController();
  console.log("[Main] Created AbortController for executeTask taskId:", id);
  abortControllers.set(id, controller);

  try {
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-start", { id });
    }

    // setTaskWorkspace is called once we know the on-disk root. For
    // local refs that's immediate; for GitHub refs we set it after the
    // clone is materialized below.
    if (ref.kind === "local") {
      setTaskWorkspace(id, ref.path);
    }

    emitTaskTraceEvent(sender, {
      taskId: id,
      type: "task-start",
      timestamp: now,
      detail: {
        workspaceKind: ref.kind,
        workspacePath: legacyWorkspacePath,
        hasHistory:
          Array.isArray(payload.history) && payload.history.length > 0,
      },
    });

    const llmConfig = payload.llmConfigId
      ? getLlmConfig(payload.llmConfigId)
      : getDefaultLlmConfig();

    // Phase 1 guard: only "chat" modality runs through the agent loop.
    // Image/video configs have a different provider API (e.g. MiniMax
    // /v1/image_generation, /v1/video_generation) and will be wired up in
    // Phase 2/3. Without this check, image/video model names get forwarded
    // to /v1/chat/completions and the upstream returns a confusing
    // "unknown model" error.
    if (llmConfig?.modality && llmConfig.modality !== "chat") {
      throw new Error(
        `此 LLM 配置的 modality 是 "${llmConfig.modality}"，聊天路径只支持 "chat"。${
          llmConfig.modality === "image" ? "图像生成" : "视频生成"
        }尚未接入（Phase 2/3 待实现）。请改用 chat 模型，或等待后续版本。`,
      );
    }

    const { model, adapter } = getModelAndAdapterByConfigId(
      payload.llmConfigId,
    );

    emitTaskTraceEvent(sender, {
      taskId: id,
      type: "model-selected",
      timestamp: new Date().toISOString(),
      detail: {
        provider: llmConfig?.provider ?? null,
        modelId: llmConfig?.model ?? null,
      },
    });

    // ── Skill matching: /command format first, then prompt-based ──
    let skill: UnifiedSkill | undefined;
    let skillArgs = "";
    const isExplicitSkillCommand = payload.prompt.startsWith("/");

    if (isExplicitSkillCommand) {
      const spaceIdx = payload.prompt.indexOf(" ");
      const command =
        spaceIdx > 0 ? payload.prompt.slice(0, spaceIdx) : payload.prompt;
      skillArgs = spaceIdx > 0 ? payload.prompt.slice(spaceIdx + 1) : "";
      console.log("[Skill Matching] Command:", command, "Args:", skillArgs);

      skill = skillRegistry.matchByCommand(command);
      console.log(
        "[Skill Matching] Found skill:",
        skill ? skill.name : "未找到",
      );

      if (!skill) {
        const cleanCommand = command.startsWith("/")
          ? command.slice(1).toLowerCase()
          : command.toLowerCase();
        const allSkills = skillRegistry.listUserVisible();
        console.log(
          "[Skill Matching] Available skills:",
          allSkills.map((s) => s.id),
        );

        const fuzzyMatch = allSkills.find(
          (s) =>
            s.id.toLowerCase().includes(cleanCommand) ||
            cleanCommand.includes(s.id.toLowerCase()) ||
            s.name.toLowerCase().includes(cleanCommand),
        );

        if (fuzzyMatch) {
          console.log("[Skill Matching] Fuzzy match found:", fuzzyMatch.name);
          skill = fuzzyMatch;
        }
      }
    }

    if (!skill) {
      skill = skillRegistry.matchByPrompt(payload.prompt);
    }

    // ── Convert history early so both fork and non-fork paths can use it ──
    let convertedHistory: import("ai").ModelMessage[] | undefined;
    if (Array.isArray(payload.history) && payload.history.length > 0) {
      try {
        const coreMessages = await convertToCoreMessages(
          payload.history as HistoryMessage[],
          { providerId: llmConfig?.provider },
        );

        let compressorCalled = false;
        const compressor = async (
          msgs: import("ai").ModelMessage[],
          budget: number,
        ) => {
          compressorCalled = true;

          // Summarize very large tool results (>60KB) before compression.
          // Only runs when context actually exceeds budget, avoiding
          // unnecessary LLM calls on short conversations.
          let preprocessed = msgs;
          try {
            preprocessed = await summarizeLargeToolResults(msgs, {
              model,
              signal: controller.signal,
              taskId: id,
              promptSnippet: payload.prompt,
            });
          } catch (err) {
            console.warn(
              "[ai:executeTask] Tool result summarization failed, continuing with raw results:",
              err instanceof Error ? err.message : err,
            );
          }

          const result = await compressContext(preprocessed, {
            model,
            budget,
            signal: controller.signal,
            taskId: id,
            promptSnippet: payload.prompt,
          });
          // Forward to renderer via IPC (compressContext already wrote to store)
          if (!sender.isDestroyed()) {
            const eventType = result.hadError
              ? "compression-error"
              : result.wasCompressed
                ? "compression-write"
                : "compression-skip";
            sender.send("ai:memory-event", {
              taskId: id,
              type: eventType,
              promptSnippet: payload.prompt?.slice(0, 80),
              detail: result.wasCompressed
                ? {
                    originalTokens: result.originalTokens,
                    compressedTokens: result.compressedTokens,
                    summaryTokens: result.summaryTokens,
                  }
                : { originalTokens: result.originalTokens },
            });
          }
          return result;
        };
        const tokenBudget = llmConfig?.model
          ? getTokenBudgetForModel(llmConfig.model)
          : undefined;
        const originalTokens = estimateTokens(coreMessages);
        const truncationResult = await truncateToFitAsync(
          coreMessages,
          tokenBudget,
          compressor,
        );
        convertedHistory = truncationResult.messages;

        emitTaskTraceEvent(sender, {
          taskId: id,
          type: "context-budget",
          timestamp: new Date().toISOString(),
          detail: {
            tokenBudget: tokenBudget ?? null,
            originalTokens,
            wasTruncated: truncationResult.wasTruncated,
            messagesDropped: truncationResult.messagesDropped,
          },
        });

        // Track when messages were silently dropped by simple truncation
        if (truncationResult.messagesDropped > 0 && !sender.isDestroyed()) {
          emitMemoryEvent(
            sender,
            id,
            "truncation-drop",
            {
              messagesDropped: truncationResult.messagesDropped,
              originalTokens,
            },
            payload.prompt,
          );
        }

        // If compressor was never called (history fits within budget),
        // still emit a compression-skip event so the debug panel shows activity
        if (!compressorCalled) {
          emitMemoryEvent(
            sender,
            id,
            "compression-skip",
            { originalTokens },
            payload.prompt,
          );
        }
      } catch (err) {
        console.warn(
          "[ai:executeTask] Failed to convert history, falling back to prompt mode:",
          err,
        );
      }
    }

    // ── Skill preprocessing & execution mode ──
    let skillPrompt = "";
    if (skill) {
      if (!sender.isDestroyed()) {
        sender.send("ai:skill-activated", {
          id,
          skillId: skill.id,
          skillName: skill.name,
          source: skill.external?.source?.type ?? "built-in",
        });
      }

      emitTaskTraceEvent(sender, {
        taskId: id,
        type: "skill-activated",
        timestamp: new Date().toISOString(),
        detail: {
          skillId: skill.id,
          skillName: skill.name,
          source: skill.external?.source?.type ?? "built-in",
          isExplicitSkillCommand,
        },
      });

      const trustLevel = skill.external
        ? getTrustLevel(skill.external.source.type)
        : "high";

      const preprocessed = await preprocessSkill(
        skill.external?.body ?? skill.systemPrompt,
        skillArgs,
        legacyWorkspacePath,
        {
          sourcePath: skill.external?.sourcePath,
          trustLevel,
        },
      );

      if (skill.external?.frontmatter.context === "fork") {
        const runSubagent = createForkSkillRunner({
          sender,
          taskId: id,
          parentSignal: controller.signal,
          workspacePath: legacyWorkspacePath,
          llmConfigId: payload.llmConfigId,
        });
        const deps: ExecutorDeps = { runSubagent };

        await executeSkill(
          {
            skill,
            processedPrompt: preprocessed.systemPrompt,
            systemPrompt: payload.prompt,
            workspacePath: legacyWorkspacePath,
            sender,
            taskId: id,
            abortSignal: controller.signal,
            injectionMode: "eager",
            history: convertedHistory,
          },
          deps,
        );

        updateTask(id, {
          status: "completed",
          result: "",
          completedAt: new Date().toISOString(),
        });
        if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
        return { id, status: "completed" };
      }

      const source = skill.external?.sourcePath ?? skill.name;
      skillPrompt = `\n\n${wrapWithSecurityBoundary(preprocessed.systemPrompt, source)}`;
    }

    const allowedTools = skill?.external?.frontmatter["allowed-tools"];
    if (allowedTools) {
      console.log(
        `[Tool Registry] Using restricted tool set for ${skill?.name}:`,
        allowedTools,
      );
    } else {
      console.log(
        `[Tool Registry] Using full tool set (no restrictions for ${skill?.name || "no skill"})`,
      );
    }
    const skillTools = skill?.tools ?? {};

    const processSkills = skillRegistry.listByCategory("process");
    const systemPrompt =
      buildAgentSystemPrompt({
        workspacePath: legacyWorkspacePath,
        skill,
        skillArgs,
        isExplicitSkillCommand,
        processSkills,
      }) + skillPrompt;

    console.log(
      `[System Prompt] Generated for skill ${skill?.name || "none"}:`,
      systemPrompt.substring(0, 200),
    );

    // ── Build messages from history (if available) ──
    const useMessagesMode = (convertedHistory?.length ?? 0) > 0;

    // ── AgentLoop driver + IPC translator ──────────────────────────
    const providerOptions = adapter.buildProviderOptions();

    // Watchdog runs across the whole agent run.
    const watchdog = new StreamWatchdog({
      taskId: id,
      sender,
      abortController: controller,
    });
    watchdog.start();

    // Coalesce text deltas into 30ms windows to throttle renderer re-renders.
    const deltaBatcher = new DeltaBatcher({
      flush: (text) => {
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-delta", { id, delta: text });
        }
      },
    });

    let fullText = "";
    let agentInputTokens: number | null = null;
    let agentOutputTokens: number | null = null;
    let agentTotalTokens: number | null = null;
    let agentProviderMeta: Record<string, unknown> | undefined;

    const sessionScope = (payload.sessionId ?? id).slice(0, 8);
    const workspace =
      ref.kind === "local"
        ? new LocalWorkspace(ref.path)
        : await createWorkspace(ref, requireWorkspaceFactoryDeps(), {
            sessionScope,
          });

    // For GitHub workspaces, register the clone dir for sandbox checks now.
    if (ref.kind !== "local") {
      setTaskWorkspace(id, workspace.root);
    }

    // ── Build the per-task ToolRegistry and merge with skill-specific tools ──
    // Registry tools (file ops + askClarification) flow through the
    // beforeToolCall approval hook. Skill-bundled tools (e.g. pdf-processor)
    // are pre-built ai-sdk Tool objects and are merged in unguarded.
    const toolRegistry = buildAgentToolRegistry({
      sender,
      taskId: id,
      workspace,
      allowedTools,
    });
    const beforeToolCall = buildApprovalHook({ sender, taskId: id });
    const registryTools = toolRegistry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace,
        signal: controller.signal,
        toolCallId,
      }),
      beforeToolCall,
    });
    const agentTools = { ...registryTools, ...skillTools };

    // Default: zero-LLM rules layer (pdfParseFailure + toolDeniedSequence)
    // attached on every task. When the skill opts in with `reflect: true`
    // — either via SKILL.md frontmatter (external skills) or via the
    // built-in TS skill's `reflect` field — we add
    // `emptyAssistantWithTools` + LLM verdict on top.
    const reflectOptIn =
      skill?.external?.frontmatter.reflect === true || skill?.reflect === true;
    const reflectHook = createReflectionGate(
      reflectOptIn
        ? { model, rules: builtinRules() }
        : { rules: defaultRules() },
    );

    const agentLoop = new AgentLoop({
      workspace,
      model,
      tools: agentTools,
      systemPrompt,
      history: useMessagesMode ? convertedHistory : undefined,
      providerOptions,
      signal: controller.signal,
      agentId: id,
      hooks: { reflect: reflectHook },
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

    const promptForLoop = useMessagesMode ? payload.prompt : payload.prompt;
    // When useMessagesMode is false, we still pass the user prompt — AgentLoop
    // appends it to history (which is empty in that case), matching the
    // pre-M1 single-shot behavior.

    console.log("[Main] Starting AgentLoop for taskId:", id);

    try {
      let manualStop = false;
      for await (const ev of agentLoop.run(
        promptForLoop,
      ) as AsyncIterable<AgentEvent>) {
        watchdog.activity();
        if (manualStopFlags.get(id)) {
          console.log("[Main] Manual stop flag detected for taskId:", id);
          manualStop = true;
          if (!controller.signal.aborted) controller.abort();
          // Continue draining events so agent_end is observed.
        }
        if (sender.isDestroyed()) break;

        switch (ev.type) {
          case "agent_start":
            // ai:stream-start was already emitted above (parity with pre-M1).
            break;
          case "message_update":
            fullText += ev.deltaText;
            deltaBatcher.push(ev.deltaText);
            break;
          case "tool_execution_start":
            deltaBatcher.drain();
            sender.send("ai:stream-tool-call", {
              id,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              args: ev.args,
            });
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: "tool-start",
              timestamp: new Date().toISOString(),
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              detail: {},
            });
            break;
          case "tool_execution_end":
            sender.send("ai:stream-tool-result", {
              id,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              result: ev.result,
            });
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: ev.success ? "tool-end" : "tool-error",
              timestamp: new Date().toISOString(),
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              detail: { ok: ev.success, durationMs: ev.durationMs },
            });
            break;
          case "retry": {
            console.log(
              `[Main] Retry attempt ${ev.attempt} for taskId: ${id}, error type: ${ev.errorType}`,
            );
            fullText = "";
            // Get the maxRetries from a fresh classification (info only).
            const retryInfo = classifyError(new Error(ev.errorType));
            if (!sender.isDestroyed()) {
              sender.send("ai:stream-retry", {
                id,
                attempt: ev.attempt,
                type: ev.errorType,
                maxRetries: retryInfo.maxRetries,
              });
            }
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: "retry",
              timestamp: new Date().toISOString(),
              detail: {
                attempt: ev.attempt,
                errorType: ev.errorType,
                maxRetries: retryInfo.maxRetries,
              },
            });
            break;
          }
          case "agent_end": {
            deltaBatcher.drain();
            agentInputTokens = ev.totalUsage?.inputTokens ?? null;
            agentOutputTokens = ev.totalUsage?.outputTokens ?? null;
            agentTotalTokens = ev.totalUsage?.totalTokens ?? null;
            agentProviderMeta = ev.providerMetadata;
            // Use AgentLoop's accumulated finalText if present (more accurate
            // post-retry than our running tally).
            if (typeof ev.finalText === "string") {
              fullText = ev.finalText;
            }

            if (ev.status === "failed") {
              const cls = classifyError(
                new Error(ev.error?.message ?? "Unknown error"),
              );
              const errorMsg =
                cls.userMessage || ev.error?.message || "Unknown error";
              updateTask(id, {
                status: "failed",
                result: errorMsg,
                completedAt: new Date().toISOString(),
              });
              emitTaskTraceEvent(sender, {
                taskId: id,
                type: "task-failed",
                timestamp: new Date().toISOString(),
                detail: {
                  status: "failed",
                  errorType: cls.type,
                  message: errorMsg,
                },
              });
              if (!sender.isDestroyed()) {
                sender.send("ai:stream-error", {
                  id,
                  error: errorMsg,
                  type: cls.type,
                  recoveryActions: cls.recoveryActions,
                });
              }
              void appendPattern({
                kind: "task",
                ts: new Date().toISOString(),
                taskId: id,
                status: "failed",
                totalUsage: ev.totalUsage,
                durationMs: Date.now() - taskStartMs,
              });
              return { id, status: "failed", message: errorMsg };
            }

            // status: "completed" or "cancelled" — both finalize as completed
            // for IPC parity (pre-M1 path also called ai:stream-done on abort).
            const wasCancelled = ev.status === "cancelled" || manualStop;
            updateTask(id, {
              status: "completed",
              result: fullText,
              completedAt: new Date().toISOString(),
              modelId: llmConfig?.model ?? null,
              provider: llmConfig?.provider ?? null,
              inputTokens: agentInputTokens,
              outputTokens: agentOutputTokens,
              totalTokens: agentTotalTokens,
            });
            // Cache events via provider adapter
            try {
              const { cacheWriteTokens: cw, cacheReadTokens: cr } =
                adapter.extractCacheMetrics(agentProviderMeta);
              if (cw && cw > 0) {
                emitMemoryEvent(
                  sender,
                  id,
                  "cache-write",
                  { cacheWriteTokens: cw },
                  payload.prompt,
                );
              }
              if (cr && cr > 0) {
                emitMemoryEvent(
                  sender,
                  id,
                  "cache-hit",
                  { cacheReadTokens: cr },
                  payload.prompt,
                );
              }
            } catch {
              // Non-critical
            }
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: wasCancelled ? "task-aborted" : "task-done",
              timestamp: new Date().toISOString(),
              detail: {
                status: "completed",
                inputTokens: agentInputTokens,
                outputTokens: agentOutputTokens,
                totalTokens: agentTotalTokens,
              },
            });
            void appendPattern({
              kind: "task",
              ts: new Date().toISOString(),
              taskId: id,
              status: wasCancelled ? "cancelled" : "completed",
              totalUsage: ev.totalUsage,
              durationMs: Date.now() - taskStartMs,
            });
            if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
            return { id, status: "completed" };
          }
        }
      }

      // Iterator exhausted without agent_end (e.g. sender destroyed) —
      // best-effort cleanup.
      updateTask(id, {
        status: "completed",
        result: fullText,
        completedAt: new Date().toISOString(),
      });
      if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
      return { id, status: "completed" };
    } finally {
      deltaBatcher.drain();
      watchdog.stop();
    }
  } catch (error: unknown) {
    const classified = classifyError(error);
    const errorMsg =
      classified.userMessage ||
      (error instanceof Error ? error.message : "Unknown error");

    updateTask(id, {
      status: "failed",
      result: errorMsg,
      completedAt: new Date().toISOString(),
    });

    emitTaskTraceEvent(sender, {
      taskId: id,
      type: "task-failed",
      timestamp: new Date().toISOString(),
      detail: {
        status: "failed",
        errorType: classified.type,
        message: errorMsg,
      },
    });

    if (!sender.isDestroyed()) {
      sender.send("ai:stream-error", {
        id,
        error: errorMsg,
        type: classified.type,
        recoveryActions: classified.recoveryActions,
      });
    }
    return { id, status: "failed", message: errorMsg };
  } finally {
    // Ensure controller is always cleaned up, even if errors occur
    // before the inner try block (e.g. in getModelAndAdapterByConfigId,
    // convertToCoreMessages, or truncateToFitAsync).
    cleanupTask(id);
  }
};

/**
 * Register all AI-related IPC handlers
 */
export const registerAIHandlers = () => {
  ipcMain.handle(
    "ai:approveToolCall",
    async (_event, payload: { toolCallId: string; approved: boolean }) => {
      const resolve = pendingApprovals.get(payload.toolCallId);
      if (resolve) {
        resolve(payload.approved);
        pendingApprovals.delete(payload.toolCallId);
        toolCallToTaskMap.delete(payload.toolCallId);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    "ai:approveToolCallBatch",
    async (_event, payload: { batchId: string; approved: boolean }) => {
      const settled = settleBatch(payload.batchId, payload.approved);
      return { ok: settled };
    },
  );

  ipcMain.handle(
    "ai:stopGeneration",
    async (_event, payload: { taskId: string }) => {
      console.log("[Main] Stop generation request for taskId:", payload.taskId);
      const stopped = stopTaskExecution(payload.taskId);
      return { ok: true, stopped };
    },
  );

  ipcMain.handle("ai:getConfig", async () => {
    return {
      provider:
        process.env.AI_PROVIDER || getSetting("ai_provider") || "openai",
      model: process.env.AI_MODEL || getSetting("ai_model") || "gpt-4o-mini",
    };
  });

  ipcMain.handle("ai:getSkills", async () => {
    return skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      suggestions: s.suggestions ?? [],
    }));
  });

  ipcMain.handle("ai:listSkills", async () => {
    return skillRegistry.listUserVisible().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.external?.source?.type ?? "built-in",
      category: s.category ?? "tool",
      keywords: s.keywords ?? [],
      suggestions: s.suggestions ?? [],
      isExternal: !!s.external,
      external: s.external
        ? {
            context: s.external.frontmatter.context ?? "default",
            allowedTools: s.external.frontmatter["allowed-tools"] ?? [],
            userInvocable: s.external.frontmatter["user-invocable"] !== false,
            disableModelInvocation:
              s.external.frontmatter["disable-model-invocation"] === true,
            requires: s.external.frontmatter.requires,
            hasHooks: !!(
              s.external.frontmatter.hooks?.["pre-activate"] ||
              s.external.frontmatter.hooks?.["post-complete"]
            ),
            sourcePath: s.external.sourcePath,
          }
        : undefined,
    }));
  });

  ipcMain.handle(
    "ai:getSkillDetail",
    async (_event, payload: { skillId: string }) => {
      const skill = skillRegistry.getById(payload.skillId);
      if (skill) {
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.external?.source?.type ?? "built-in",
          category: skill.category ?? "tool",
          keywords: skill.keywords ?? [],
          suggestions: skill.suggestions ?? [],
          systemPrompt: skill.external ? undefined : skill.systemPrompt,
          isExternal: !!skill.external,
          enabled: true,
          eligible: true,
          external: skill.external
            ? {
                context: skill.external.frontmatter.context ?? "default",
                allowedTools: skill.external.frontmatter["allowed-tools"] ?? [],
                userInvocable:
                  skill.external.frontmatter["user-invocable"] !== false,
                disableModelInvocation:
                  skill.external.frontmatter["disable-model-invocation"] ===
                  true,
                requires: skill.external.frontmatter.requires,
                hasHooks: !!(
                  skill.external.frontmatter.hooks?.["pre-activate"] ||
                  skill.external.frontmatter.hooks?.["post-complete"]
                ),
                sourcePath: skill.external.sourcePath,
                body: skill.external.body,
              }
            : undefined,
        };
      }

      // Fallback: skill is discovered but not registered (e.g. a
      // disabled personal/additional skill). Render its metadata so the
      // user can preview the skill and choose to enable it inline.
      const discovered = skillRegistry.getDiscovered(payload.skillId);
      if (!discovered) return null;
      const fm = discovered.parsed.frontmatter;
      return {
        id: discovered.skillId,
        name: fm.name ?? discovered.skillId,
        description: fm.description ?? "",
        source: discovered.source.type,
        category: "tool" as const,
        keywords: [],
        suggestions: [],
        systemPrompt: undefined,
        isExternal: true,
        enabled: false,
        eligible: discovered.eligible,
        ineligibleReason: discovered.ineligibleReason,
        external: {
          context: fm.context ?? "default",
          allowedTools: fm["allowed-tools"] ?? [],
          userInvocable: fm["user-invocable"] !== false,
          disableModelInvocation: fm["disable-model-invocation"] === true,
          requires: fm.requires,
          hasHooks: !!(
            fm.hooks?.["pre-activate"] || fm.hooks?.["post-complete"]
          ),
          sourcePath: discovered.parsed.sourcePath,
          body: discovered.parsed.body,
        },
      };
    },
  );

  ipcMain.handle(
    "ai:initSkills",
    async (
      _event,
      payload: { workspacePath: string; additionalDirs?: string[] },
    ) => {
      try {
        const count = await initSkillDiscovery(
          skillRegistry,
          payload.workspacePath,
          payload.additionalDirs,
        );
        return { ok: true, registered: count };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[ai:initSkills] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "ai:refreshSkills",
    async (_event, payload: { workspacePath: string }) => {
      try {
        await skillRegistry.refreshProjectSkills(payload.workspacePath);
        return { ok: true };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[ai:refreshSkills] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );

  // Skills modal: full inventory, including disabled-by-source and
  // ineligible entries. Built-in skills are merged in as always-enabled.
  ipcMain.handle("ai:listAllSkills", async () => {
    const builtIns = skillRegistry.listAll().filter((s) => !s.external);
    const builtInItems = builtIns.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: "built-in" as const,
      category: s.category ?? "tool",
      keywords: s.keywords ?? [],
      suggestions: s.suggestions ?? [],
      isExternal: false,
      enabled: true,
      eligible: true,
      external: undefined,
    }));

    const externalItems = skillRegistry.listAllDiscovered().map((d) => {
      const fm = d.frontmatter;
      const userInvocable = fm["user-invocable"] !== false;
      return {
        id: d.skillId,
        name: d.name,
        description: d.description,
        source: d.source.type,
        category: "tool" as const,
        keywords: [],
        suggestions: [],
        isExternal: true,
        enabled: d.enabled,
        eligible: d.eligible,
        ineligibleReason: d.ineligibleReason,
        external: {
          context: fm.context ?? "default",
          allowedTools: fm["allowed-tools"] ?? [],
          userInvocable,
          disableModelInvocation: fm["disable-model-invocation"] === true,
          requires: fm.requires,
          hasHooks: !!(
            fm.hooks?.["pre-activate"] || fm.hooks?.["post-complete"]
          ),
          sourcePath: d.sourcePath,
        },
      };
    });

    // Filter out non-user-invocable external skills so the modal mirrors
    // the existing listUserVisible() contract for invocability.
    return [
      ...builtInItems,
      ...externalItems.filter((s) => s.external?.userInvocable !== false),
    ];
  });

  ipcMain.handle(
    "ai:setSkillEnabled",
    async (_event, payload: { skillId: string; enabled: boolean }) => {
      try {
        const inventory = skillRegistry.listAllDiscovered();
        const entry = inventory.find((d) => d.skillId === payload.skillId);
        if (!entry) {
          return { ok: false, error: `Unknown skill: ${payload.skillId}` };
        }
        if (
          entry.source.type !== "personal" &&
          entry.source.type !== "additional"
        ) {
          return {
            ok: false,
            error: `Only personal and additional skills can be toggled (source: ${entry.source.type})`,
          };
        }

        skillRegistry.setSkillEnabled(payload.skillId, payload.enabled);

        // Persist allow-list as a JSON-encoded array of skill IDs.
        const ids = skillRegistry.getEnabledSkillIds();
        setSetting("skills.enabled-ids", JSON.stringify(ids));

        return { ok: true };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[ai:setSkillEnabled] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle("ai:getSuggestions", async () => {
    return getAllSuggestions();
  });

  ipcMain.handle("ai:executeTask", handleTaskExecution);

  registerPlanHandlers();

  registerUsageHandlers();

  registerMemoryDebugHandlers();
};
