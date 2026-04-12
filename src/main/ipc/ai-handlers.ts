/**
 * AI Handlers - Main IPC Handler Registration
 *
 * Orchestrates AI-related IPC handlers and task execution.
 * This is the refactored, smaller main handler file.
 */

import { ipcMain } from "electron";
import crypto from "node:crypto";
import { streamText, stepCountIs } from "ai";
import { addTask, updateTask, getSetting } from "../db";
import { skills, getAllSuggestions, skillRegistry } from "../skills";
import {
  preprocessSkill,
  executeSkill,
  wrapWithSecurityBoundary,
  getTrustLevel,
  initSkillDiscovery,
} from "../skills-runtime";
import type { ExecutorDeps } from "../skills-runtime";
import type { UnifiedSkill } from "../skills-runtime/types";
import { convertToCoreMessages, type HistoryMessage } from "../ai/message-converter";
import { truncateToFit } from "../ai/token-budget";

// Import our new modules
import { getAIModelByConfigId, isAuthError } from "./ai-models";
import {
  abortControllers,
  manualStopFlags,
  pendingApprovals,
  toolCallToTaskMap,
  cleanupTask,
  stopTaskExecution
} from "./ai-task-control";
import {
  buildTools,
  buildSkillSpecificTools
} from "./ai-tool-permissions";
import { rawExecutors, safeTools } from "./ai-tools";
import { registerPlanHandlers } from "./ai-plan-handlers";

/**
 * Enhanced system prompt generation based on skill usage
 */
const buildSystemPrompt = (
  workspacePath: string,
  skill?: UnifiedSkill,
  skillArgs?: string,
  isExplicitSkillCommand?: boolean
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
      // For explicit skill commands, be more directive
      systemPrompt += `\n\n重要：用户已明确调用 ${skill.name} 技能执行任务: "${skillArgs}"
请直接执行指定任务，不要进行不必要的环境探索或目录列举。`;

      // Special handling for agent-browser
      if (skill.id === "agent-browser") {
        systemPrompt += `\n当前任务是网页相关操作，请直接使用 npx agent-browser 命令执行任务，避免使用其他文件操作工具。`;
      }
    }

    // Add tool restriction notice if applicable
    if (skill.external?.frontmatter["allowed-tools"]) {
      const allowedTools = skill.external.frontmatter["allowed-tools"];
      systemPrompt += `\n\n工具限制：当前技能仅允许使用以下工具: ${allowedTools.join(", ")}`;
    }
  } else {
    // For non-skill tasks, keep the original behavior
    systemPrompt += `\n- Before making changes, list the directory to understand the current structure.
- Explain what you did after completing the task.`;
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
    history?: Array<{ role: string; content: string; parts?: unknown[] }>
  }
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

  // Create AbortController early so its signal can be passed into streaming APIs
  const controller = new AbortController();
  console.log("[Main] Created AbortController for executeTask taskId:", id);
  abortControllers.set(id, controller);

  try {
    // Notify renderer of the task id before streaming starts
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-start", { id });
    }

    const model = getAIModelByConfigId(payload.llmConfigId);

    // ── Skill matching: /command format first, then prompt-based ──
    let skill: UnifiedSkill | undefined;
    let skillArgs = "";
    const isExplicitSkillCommand = payload.prompt.startsWith("/");

    if (isExplicitSkillCommand) {
      const spaceIdx = payload.prompt.indexOf(" ");
      const command = spaceIdx > 0 ? payload.prompt.slice(0, spaceIdx) : payload.prompt;
      skillArgs = spaceIdx > 0 ? payload.prompt.slice(spaceIdx + 1) : "";
      console.log("[Skill Matching] Command:", command, "Args:", skillArgs);

      skill = skillRegistry.matchByCommand(command);
      console.log("[Skill Matching] Found skill:", skill ? skill.name : "未找到");

      if (!skill) {
        // Try fuzzy matching as fallback
        const cleanCommand = command.startsWith("/") ? command.slice(1).toLowerCase() : command.toLowerCase();
        const allSkills = skillRegistry.listUserVisible();
        console.log("[Skill Matching] Available skills:", allSkills.map(s => s.id));

        // Try to find a skill that contains the command or vice versa
        const fuzzyMatch = allSkills.find(s =>
          s.id.toLowerCase().includes(cleanCommand) ||
          cleanCommand.includes(s.id.toLowerCase()) ||
          s.name.toLowerCase().includes(cleanCommand)
        );

        if (fuzzyMatch) {
          console.log("[Skill Matching] Fuzzy match found:", fuzzyMatch.name);
          skill = fuzzyMatch;
        }
      }
    }

    // Fall back to prompt-based matching
    if (!skill) {
      skill = skillRegistry.matchByPrompt(payload.prompt);
    }

    // ── Convert history early so both fork and non-fork paths can use it ──
    let convertedHistory: import("ai").ModelMessage[] | undefined;
    if (Array.isArray(payload.history) && payload.history.length > 0) {
      try {
        const coreMessages = convertToCoreMessages(payload.history as HistoryMessage[]);
        const { messages: truncatedMessages } = truncateToFit(coreMessages);
        convertedHistory = truncatedMessages;
      } catch (err) {
        console.warn("[ai:executeTask] Failed to convert history, falling back to prompt mode:", err);
      }
    }

    // ── Skill preprocessing & execution mode ──
    let skillPrompt = "";
    if (skill) {
      // Notify renderer of skill activation
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

      // Check if this is a fork-mode skill
      if (skill.external?.frontmatter.context === "fork") {
        // Use skill-specific tools if allowed-tools is configured
        const allowedTools = skill.external?.frontmatter["allowed-tools"];
        const tools = allowedTools && allowedTools.length > 0
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

        // Fork mode handles its own streaming, so we're done
        updateTask(id, {
          status: "completed",
          result: "",
          completedAt: new Date().toISOString(),
        });
        if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
        return { id, status: "completed" };
      }

      // Default mode: wrap with security boundary for injection
      const source = skill.external?.sourcePath ?? skill.name;
      skillPrompt = `\n\n${wrapWithSecurityBoundary(preprocessed.systemPrompt, source)}`;
    }

    // Build tools with approval guards for dangerous operations
    // Use skill-specific tools if skill has allowed-tools configuration
    let originalTools: Record<string, import("ai").Tool>;
    if (skill?.external?.frontmatter["allowed-tools"]) {
      const allowedTools = skill.external.frontmatter["allowed-tools"];
      console.log(`[Skill Tools] Using restricted tool set for ${skill.name}:`, allowedTools);
      originalTools = buildSkillSpecificTools(allowedTools, sender, id);
    } else {
      console.log(`[Skill Tools] Using full tool set (no restrictions for ${skill?.name || 'no skill'})`);
      originalTools = buildTools(sender, id);
    }
    const skillTools = skill?.tools ?? {};

    // Build enhanced system prompt based on skill usage
    const systemPrompt = buildSystemPrompt(
      payload.workspacePath,
      skill,
      skillArgs,
      isExplicitSkillCommand
    ) + skillPrompt;

    console.log(`[System Prompt] Generated for skill ${skill?.name || 'none'}:`, systemPrompt.substring(0, 200));

    // ── Build messages from history (if available) ──
    const useMessagesMode = !!convertedHistory?.length;
    const builtMessages: import("ai").ModelMessage[] = useMessagesMode
      ? [...convertedHistory!, { role: "user" as const, content: payload.prompt }]
      : [];

    const result = useMessagesMode
      ? streamText({
          model,
          tools: { ...originalTools, ...skillTools },
          stopWhen: stepCountIs(20),
          system: systemPrompt,
          messages: builtMessages,
          abortSignal: controller.signal,
        })
      : streamText({
          model,
          tools: { ...originalTools, ...skillTools },
          stopWhen: stepCountIs(20),
          system: systemPrompt,
          prompt: payload.prompt,
          abortSignal: controller.signal,
        });

    // Stream full events (text deltas + tool calls) to renderer
    let fullText = "";
    let partCount = 0;
    console.log("[Main] Starting stream loop for taskId:", id);

    try {
      for await (const part of result.fullStream) {
        partCount++;
        console.log(`[Main] Processing part ${partCount} for taskId:`, id, "type:", part.type);

        // Check manual stop flag
        if (manualStopFlags.get(id)) {
          console.log("[Main] Manual stop flag detected for taskId:", id);
          break;
        }

        if (sender.isDestroyed()) break;

        switch (part.type) {
          case "text-delta":
            fullText += part.text;
            sender.send("ai:stream-delta", { id, delta: part.text });
            break;
          case "tool-call":
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
        }
      }

      updateTask(id, {
        status: "completed",
        result: fullText,
        completedAt: new Date().toISOString(),
      });

      if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
      return { id, status: "completed" };

    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("[Main] AbortError caught, cleaning up for taskId:", id);
        updateTask(id, { status: "completed", result: fullText, completedAt: new Date().toISOString() });
        if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
        return { id, status: "completed" };
      }

      const errorMsg = isAuthError(error)
        ? "API Key 无效或已过期，请在设置中检查该渠道配置"
        : error instanceof Error ? error.message : "Unknown error";

      updateTask(id, {
        status: "failed",
        result: errorMsg,
        completedAt: new Date().toISOString(),
      });

      if (!sender.isDestroyed()) {
        sender.send("ai:stream-error", { id, error: errorMsg });
      }
      return { id, status: "failed", message: errorMsg };

    } finally {
      console.log("[Main] Cleanup for taskId:", id);
      cleanupTask(id);
    }

  } catch (error: unknown) {
    const errorMsg = isAuthError(error)
      ? "API Key 无效或已过期，请在设置中检查该渠道配置"
      : error instanceof Error ? error.message : "Unknown error";

    updateTask(id, {
      status: "failed",
      result: errorMsg,
      completedAt: new Date().toISOString(),
    });

    if (!sender.isDestroyed()) {
      sender.send("ai:stream-error", { id, error: errorMsg });
    }
    return { id, status: "failed", message: errorMsg };
  }
};

/**
 * Register all AI-related IPC handlers
 */
export const registerAIHandlers = () => {
  // Handle approval responses from the renderer
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

  // Handle stop-generation requests from the renderer
  ipcMain.handle(
    "ai:stopGeneration",
    async (_event, payload: { taskId: string }) => {
      console.log("[Main] Stop generation request for taskId:", payload.taskId);
      const stopped = stopTaskExecution(payload.taskId);
      return { ok: true, stopped };
    },
  );

  // Configuration and skill handlers
  ipcMain.handle("ai:getConfig", async () => {
    return {
      provider: process.env.AI_PROVIDER || getSetting("ai_provider") || "openai",
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

  ipcMain.handle("ai:getSkillDetail", async (_event, payload: { skillId: string }) => {
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
            userInvocable: skill.external.frontmatter["user-invocable"] !== false,
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
  });

  ipcMain.handle(
    "ai:initSkills",
    async (_event, payload: { workspacePath: string; additionalDirs?: string[] }) => {
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

  // Task execution handler
  ipcMain.handle("ai:executeTask", handleTaskExecution);

  // Register plan-related handlers
  registerPlanHandlers();
};
