/**
 * AI Handlers - Main IPC Handler Registration
 *
 * Orchestrates AI-related IPC handlers and task execution.
 * This is the refactored, smaller main handler file.
 */

import crypto from "node:crypto";
import { stepCountIs, streamText } from "ai";
import { ipcMain } from "electron";
import { compressContext } from "../ai/context-compressor";
import { DeltaBatcher } from "../ai/delta-batcher";
import { classifyError, withRetry } from "../ai/error-classifier";
import { emitMemoryEvent } from "../ai/memory-debug-store";
import {
  convertToCoreMessages,
  type HistoryMessage,
} from "../ai/message-converter";
import { summarizeLargeToolResults } from "../ai/result-summarizer";
import { StreamWatchdog } from "../ai/stream-watchdog";
import {
  estimateTokens,
  getTokenBudgetForModel,
  truncateToFitAsync,
} from "../ai/token-budget";
import {
  addTask,
  getDefaultLlmConfig,
  getLlmConfig,
  getSetting,
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
// Import our new modules
import {
  getAIModelByConfigId,
  getModelAndAdapterByConfigId,
} from "./ai-models";
import { registerPlanHandlers } from "./ai-plan-handlers";
import {
  abortControllers,
  cleanupTask,
  manualStopFlags,
  pendingApprovals,
  stopTaskExecution,
  toolCallToTaskMap,
} from "./ai-task-control";
import { buildSkillSpecificTools, buildTools } from "./ai-tool-permissions";
import { rawExecutors, safeTools } from "./ai-tools";
import { registerMemoryDebugHandlers } from "./memory-debug-handlers";
import { registerUsageHandlers } from "./usage-handlers";

/**
 * Enhanced system prompt generation based on skill usage
 */
const buildSystemPrompt = (
  workspacePath: string,
  skill?: UnifiedSkill,
  skillArgs?: string,
  isExplicitSkillCommand?: boolean,
): string => {
  let systemPrompt = `You are FileWork, a local file management AI assistant. You help users organize, analyze, and manage files in their directories.

Current workspace: ${workspacePath}

Rules:
- Always use absolute paths based on the workspace path provided.
- Be careful with delete operations — confirm the scope is correct.
- Respond in the same language as the user's prompt.`;

  // Add skill-specific instructions
  if (skill) {
    if (isExplicitSkillCommand) {
      systemPrompt += `\n\n重要：用户已明确调用 ${skill.name} 技能执行任务: "${skillArgs}"
请直接执行指定任务，不要进行不必要的环境探索或目录列举。`;

      if (skill.id === "agent-browser") {
        systemPrompt += `\n当前任务是网页相关操作，请直接使用 npx agent-browser 命令执行任务，避免使用其他文件操作工具。`;
      }
    }

    if (skill.external?.frontmatter["allowed-tools"]) {
      const allowedTools = skill.external.frontmatter["allowed-tools"];
      systemPrompt += `\n\n工具限制：当前技能仅允许使用以下工具: ${allowedTools.join(", ")}`;
    }
  } else {
    systemPrompt += `

## Behavioral Guidelines

### Before Acting
- State your assumptions explicitly. If the user's intent is ambiguous, ask before executing.
- If multiple interpretations exist, present them briefly — don't pick silently.

### Simplicity
- Use the minimum number of tool calls needed. Don't explore directories unless the task requires it.
- Don't add features, error handling, or abstractions beyond what was asked.

### Surgical Precision
- Only modify files directly related to the user's request.
- Don't "improve" adjacent code, comments, or formatting.
- If you notice unrelated issues, mention them — don't fix them.

### Verification
- After completing a task, briefly verify the result (e.g., read the created file, check the output).
- State what was done and what was verified.`;
  }

  return systemPrompt;
};

/**
 * Main task execution handler
 */
const handleTaskExecution = async (
  event: Electron.IpcMainInvokeEvent,
  payload: {
    prompt: string;
    workspacePath: string;
    llmConfigId?: string;
    history?: Array<{ role: string; content: string; parts?: unknown[] }>;
  },
) => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
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

    const llmConfig = payload.llmConfigId
      ? getLlmConfig(payload.llmConfigId)
      : getDefaultLlmConfig();
    const { model, adapter } = getModelAndAdapterByConfigId(
      payload.llmConfigId,
    );

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
        const coreMessages = convertToCoreMessages(
          payload.history as HistoryMessage[],
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

      const trustLevel = skill.external
        ? getTrustLevel(skill.external.source.type)
        : "high";

      const preprocessed = await preprocessSkill(
        skill.external?.body ?? skill.systemPrompt,
        skillArgs,
        payload.workspacePath,
        {
          sourcePath: skill.external?.sourcePath,
          trustLevel,
        },
      );

      if (skill.external?.frontmatter.context === "fork") {
        const allowedTools = skill.external?.frontmatter["allowed-tools"];
        const tools =
          allowedTools && allowedTools.length > 0
            ? buildSkillSpecificTools(allowedTools, sender, id)
            : buildTools(sender, id);
        const deps: ExecutorDeps = {
          getModel: () => getAIModelByConfigId(payload.llmConfigId) as any,
          allTools: tools,
          rawExecutors,
          safeTools,
        };

        await executeSkill(
          {
            skill,
            processedPrompt: preprocessed.systemPrompt,
            systemPrompt: payload.prompt,
            workspacePath: payload.workspacePath,
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

    let originalTools: Record<string, import("ai").Tool>;
    if (skill?.external?.frontmatter["allowed-tools"]) {
      const allowedTools = skill.external.frontmatter["allowed-tools"];
      console.log(
        `[Skill Tools] Using restricted tool set for ${skill.name}:`,
        allowedTools,
      );
      originalTools = buildSkillSpecificTools(allowedTools, sender, id);
    } else {
      console.log(
        `[Skill Tools] Using full tool set (no restrictions for ${skill?.name || "no skill"})`,
      );
      originalTools = buildTools(sender, id);
    }
    const skillTools = skill?.tools ?? {};

    const systemPrompt =
      buildSystemPrompt(
        payload.workspacePath,
        skill,
        skillArgs,
        isExplicitSkillCommand,
      ) + skillPrompt;

    console.log(
      `[System Prompt] Generated for skill ${skill?.name || "none"}:`,
      systemPrompt.substring(0, 200),
    );

    // ── Build messages from history (if available) ──
    const useMessagesMode = !!convertedHistory?.length;
    const builtMessages: import("ai").ModelMessage[] = useMessagesMode
      ? [
          ...convertedHistory!,
          { role: "user" as const, content: payload.prompt },
        ]
      : [];

    // ── Streaming with automatic retry ──
    const providerOptions = adapter.buildProviderOptions();

    const streamAndConsume = async () => {
      const commonOptions = {
        model,
        tools: { ...originalTools, ...skillTools },
        stopWhen: stepCountIs(20),
        system: systemPrompt,
        abortSignal: controller.signal,
        providerOptions,
      };

      const streamOptions = useMessagesMode
        ? { ...commonOptions, messages: builtMessages }
        : { ...commonOptions, prompt: payload.prompt };

      const result = streamText(streamOptions);

      // Start watchdog for heartbeat & stall detection
      const watchdog = new StreamWatchdog({
        taskId: id,
        sender,
        abortController: controller,
      });
      watchdog.start();

      // Batch text-delta IPC events into 50ms windows to reduce renderer
      // re-renders from 50+/s down to ~20/s.
      const deltaBatcher = new DeltaBatcher({
        flush: (text) => {
          if (!sender.isDestroyed()) {
            sender.send("ai:stream-delta", { id, delta: text });
          }
        },
      });

      try {
        let partCount = 0;
        for await (const part of result.fullStream) {
          watchdog.activity();
          partCount++;
          console.log(
            `[Main] Processing part ${partCount} for taskId:`,
            id,
            "type:",
            part.type,
          );

          if (manualStopFlags.get(id)) {
            console.log("[Main] Manual stop flag detected for taskId:", id);
            break;
          }

          if (sender.isDestroyed()) break;

          switch (part.type) {
            case "text-delta":
              fullText += part.text;
              deltaBatcher.push(part.text);
              break;
            case "tool-call":
              // Flush pending text before tool events so ordering is preserved
              deltaBatcher.drain();
              sender.send("ai:stream-tool-call", {
                id,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.input,
              });
              break;
            case "tool-result":
              sender.send("ai:stream-tool-result", {
                id,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                result: part.output,
              });
              break;
            case "error":
              // Flush pending text before surfacing the error
              deltaBatcher.drain();
              // AI SDK v6 wraps API errors as stream events instead of
              // throwing.  Re-throw so withRetry / our catch block can
              // classify and surface the error to the renderer.
              throw part.error;
          }
        }
      } finally {
        // Ensure any remaining buffered text is sent before cleanup
        deltaBatcher.drain();
        watchdog.stop();
      }

      return result;
    };

    let fullText = "";
    console.log("[Main] Starting stream loop for taskId:", id);

    try {
      const streamResult = await withRetry(streamAndConsume, {
        signal: controller.signal,
        onRetry: (attempt, classified) => {
          console.log(
            `[Main] Retry attempt ${attempt} for taskId: ${id}, error type: ${classified.type}`,
          );
          fullText = "";
          if (!sender.isDestroyed()) {
            sender.send("ai:stream-retry", {
              id,
              attempt,
              type: classified.type,
              maxRetries: classified.maxRetries,
            });
          }
        },
      });

      // Track token usage (AI SDK v6: totalUsage aggregates all steps)
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let totalTokens: number | null = null;
      try {
        const usage = await streamResult.totalUsage;
        if (usage) {
          inputTokens = usage.inputTokens ?? null;
          outputTokens = usage.outputTokens ?? null;
          totalTokens =
            inputTokens != null || outputTokens != null
              ? (inputTokens ?? 0) + (outputTokens ?? 0)
              : null;
        }
      } catch {
        // Usage read failure is non-critical
      }

      // Track prompt-cache events via provider adapter
      try {
        const providerMeta = await streamResult.providerMetadata;
        const promptSnippet = payload.prompt;
        const { cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead } =
          adapter.extractCacheMetrics(
            providerMeta as Record<string, unknown> | undefined,
          );

        if (cacheWrite && cacheWrite > 0) {
          emitMemoryEvent(
            sender,
            id,
            "cache-write",
            {
              cacheWriteTokens: cacheWrite,
            },
            promptSnippet,
          );
        }
        if (cacheRead && cacheRead > 0) {
          emitMemoryEvent(
            sender,
            id,
            "cache-hit",
            {
              cacheReadTokens: cacheRead,
            },
            promptSnippet,
          );
        }
      } catch {
        // Cache metadata read failure is non-critical
      }

      updateTask(id, {
        status: "completed",
        result: fullText,
        completedAt: new Date().toISOString(),
        modelId: llmConfig?.model ?? null,
        provider: llmConfig?.provider ?? null,
        inputTokens,
        outputTokens,
        totalTokens,
      });

      if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
      return { id, status: "completed" };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("[Main] AbortError caught, cleaning up for taskId:", id);
        updateTask(id, {
          status: "completed",
          result: fullText,
          completedAt: new Date().toISOString(),
        });
        if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
        return { id, status: "completed" };
      }

      const classified = classifyError(error);
      const errorMsg =
        classified.userMessage ||
        (error instanceof Error ? error.message : "Unknown error");

      updateTask(id, {
        status: "failed",
        result: errorMsg,
        completedAt: new Date().toISOString(),
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
      if (!skill) return null;
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
        external: skill.external
          ? {
              context: skill.external.frontmatter.context ?? "default",
              allowedTools: skill.external.frontmatter["allowed-tools"] ?? [],
              userInvocable:
                skill.external.frontmatter["user-invocable"] !== false,
              disableModelInvocation:
                skill.external.frontmatter["disable-model-invocation"] === true,
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

  ipcMain.handle("ai:getSuggestions", async () => {
    return getAllSuggestions();
  });

  ipcMain.handle("ai:executeTask", handleTaskExecution);

  registerPlanHandlers();

  registerUsageHandlers();

  registerMemoryDebugHandlers();
};
