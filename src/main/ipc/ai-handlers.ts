import { ipcMain } from "electron";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import type { Tool } from "ai";
import { streamText, stepCountIs } from "ai";
import { z } from "zod/v4";
import { addTask, getSetting, updateTask, getDefaultLlmConfig, getLlmConfig } from "../db";
import { matchSkill, skills, getAllSuggestions, skillRegistry } from "../skills";
import { needsPlanning, planTask } from "../planner";
import { executePlan, cancelPlan } from "../planner/executor";
import type { Plan } from "../planner/types";
import {
  preprocessSkill,
  executeSkill,
  wrapWithSecurityBoundary,
  getTrustLevel,
  initSkillDiscovery,
} from "../skills-runtime";
import type { ExecutorDeps } from "../skills-runtime";
import type { UnifiedSkill } from "../skills-runtime/types";
import { convertToCoreMessages } from "../ai/message-converter";
import type { HistoryMessage } from "../ai/message-converter";
import { truncateToFit } from "../ai/token-budget";

/** 按任务 ID 存储活跃的 AbortController，用于中止流式生成 */
export const abortControllers = new Map<string, AbortController>();

/** 按任务 ID 存储手动停止标志，用于强制中止流式生成 */
export const manualStopFlags = new Map<string, boolean>();

const getAIModelByConfigId = (configId?: string) => {
  const config = configId ? getLlmConfig(configId) : getDefaultLlmConfig();
  if (!config) {
    throw new Error("所选 LLM 配置不存在");
  }

  const { provider, apiKey, baseUrl, model: modelId } = config;
  console.log("[AI] provider:", provider, "model:", modelId, "configId:", config.id);

  if (provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: apiKey || "",
      baseURL: baseUrl || undefined,
    });
    return anthropic(modelId);
  }

  if (provider === "deepseek") {
    const deepseek = createDeepSeek({
      apiKey: apiKey || "",
    });
    return deepseek(modelId);
  }

  if (provider === "ollama") {
    const ollama = createOpenAI({
      apiKey: "ollama",
      baseURL: baseUrl || "http://localhost:11434/v1",
    });
    return ollama.chat(modelId);
  }

  // provider === "openai" or "custom"
  const isCustomEndpoint =
    provider === "custom" || (baseUrl != null && !baseUrl.includes("api.openai.com"));
  const openai = createOpenAI({
    apiKey: apiKey || "",
    baseURL: baseUrl || undefined,
  });
  return isCustomEndpoint ? openai.chat(modelId) : openai(modelId);
};

/** Check if an error is an authentication failure (401/403) */
const isAuthError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const msg = error.message;
    return msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("Forbidden");
  }
  return false;
};

const pathSchema = z.object({ path: z.string().describe("Absolute path") });

/** Human-readable descriptions for dangerous operations */
const dangerousToolDescriptions: Record<string, (args: Record<string, unknown>) => string> = {
  deleteFile: (args) => `删除 ${args.path}`,
  writeFile: (args) => `写入文件 ${args.path}`,
  moveFile: (args) => `移动 ${args.source} → ${args.destination}`,
};

/**
 * Pending approval requests. The main process sends an approval request to the
 * renderer and stores a resolve callback here. When the renderer responds via
 * the `ai:approveToolCall` IPC channel, the promise resolves.
 */
const pendingApprovals = new Map<string, (approved: boolean) => void>();

/** Track which task each tool call belongs to for cleanup purposes */
const toolCallToTaskMap = new Map<string, string>();

/** Request approval from the renderer and wait for the response */
const requestApproval = (
  sender: Electron.WebContents,
  taskId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(toolCallId, resolve);
    toolCallToTaskMap.set(toolCallId, taskId);
    if (!sender.isDestroyed()) {
      const describeFn = dangerousToolDescriptions[toolName];
      const description = describeFn
        ? describeFn(args as Record<string, unknown>)
        : `${toolName}`;
      sender.send("ai:stream-tool-approval", {
        id: taskId,
        toolCallId,
        toolName,
        args,
        description,
      });
    }
  });
};

/** Raw execute functions for dangerous tools (without approval guard) */
const rawExecutors = {
  writeFile: async ({ path: filePath, content }: { path: string; content: string }) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return { success: true, path: filePath };
  },
  moveFile: async ({ source, destination }: { source: string; destination: string }) => {
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    return { success: true, source, destination };
  },
  deleteFile: async ({ path: targetPath }: { path: string }) => {
    await rm(targetPath, { recursive: true });
    return { success: true, path: targetPath };
  },
};

/** Safe (read-only) tools — shared across all requests */
const safeTools: Record<string, Tool> = {
  listDirectory: {
    description: "List files and directories at the given path",
    inputSchema: pathSchema,
    execute: async ({ path: dirPath }: { path: string }) => {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const results: Array<{
        name: string;
        path: string;
        isDirectory: boolean;
        size: number;
        extension: string;
        modifiedAt: string;
      }> = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = join(dirPath, entry.name);
        try {
          const stats = await stat(fullPath);
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            extension: entry.isDirectory() ? "" : extname(entry.name),
            modifiedAt: stats.mtime.toISOString(),
          });
        } catch {
          // skip inaccessible
        }
      }
      return results;
    },
  },

  readFile: {
    description: "Read the text content of a file",
    inputSchema: pathSchema,
    execute: async ({ path: filePath }: { path: string }) => {
      const content = await readFile(filePath, "utf-8");
      return content.length > 50000 ? `${content.slice(0, 50000)}\n...(truncated)` : content;
    },
  },

  createDirectory: {
    description: "Create a directory (including parent directories)",
    inputSchema: pathSchema,
    execute: async ({ path: dirPath }: { path: string }) => {
      await mkdir(dirPath, { recursive: true });
      return { success: true, path: dirPath };
    },
  },

  runCommand: {
    description:
      "Run a shell command in the workspace directory. Returns stdout, stderr, and exit code. Timeout: 60s.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory (absolute path, defaults to workspace root)"),
    }),
    execute: async ({ command, cwd: cwdArg }: { command: string; cwd?: string }) => {
      const { exec: execCb } = await import("node:child_process");
      const runCwd = cwdArg || process.cwd();
      const TIMEOUT_MS = 60_000;
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        execCb(command, { cwd: runCwd, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            resolve({
              stdout: stdout?.toString() ?? "",
              stderr: stderr?.toString() || error.message,
              exitCode: error.code != null ? (typeof error.code === "number" ? error.code : 1) : 1,
            });
            return;
          }
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode: 0,
          });
        });
      });
    },
  },

  directoryStats: {
    description: "Get statistics about a directory (file count, size, extensions)",
    inputSchema: pathSchema,
    execute: async ({ path: dirPath }: { path: string }) => {
      const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
      let totalFiles = 0;
      let totalDirs = 0;
      let totalSize = 0;
      const extensions: Record<string, number> = {};
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(entry.parentPath || dirPath, entry.name);
        if (fullPath.includes("/.filework/") || fullPath.includes("/node_modules/")) continue;
        try {
          if (entry.isDirectory()) {
            totalDirs++;
          } else {
            totalFiles++;
            const s = await stat(fullPath);
            totalSize += s.size;
            const ext = extname(entry.name) || "(no ext)";
            extensions[ext] = (extensions[ext] || 0) + 1;
          }
        } catch {
          // skip
        }
      }
      return { totalFiles, totalDirs, totalSize, extensions };
    },
  },
};

/**
 * Build the full tool set for a specific request.
 * Dangerous tools are wrapped with an approval guard that pauses execution
 * until the user approves or rejects via the renderer.
 */
const buildTools = (
  sender: Electron.WebContents,
  taskId: string,
): Record<string, Tool> => {
  const guardedWriteFile: Tool = {
    description: "Write content to a file (creates or overwrites). Requires user approval.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Content to write"),
    }),
    execute: async (args: { path: string; content: string }, { toolCallId }) => {
      const approved = await requestApproval(sender, taskId, toolCallId, "writeFile", { path: args.path });
      if (!approved) return { success: false, denied: true, reason: "用户拒绝了此操作" };
      return rawExecutors.writeFile(args);
    },
  };

  const guardedMoveFile: Tool = {
    description: "Move or rename a file/directory. Requires user approval.",
    inputSchema: z.object({
      source: z.string().describe("Source absolute path"),
      destination: z.string().describe("Destination absolute path"),
    }),
    execute: async (args: { source: string; destination: string }, { toolCallId }) => {
      const approved = await requestApproval(sender, taskId, toolCallId, "moveFile", args);
      if (!approved) return { success: false, denied: true, reason: "用户拒绝了此操作" };
      return rawExecutors.moveFile(args);
    },
  };

  const guardedDeleteFile: Tool = {
    description: "Delete a file or directory. Requires user approval.",
    inputSchema: pathSchema,
    execute: async (args: { path: string }, { toolCallId }) => {
      const approved = await requestApproval(sender, taskId, toolCallId, "deleteFile", args);
      if (!approved) return { success: false, denied: true, reason: "用户拒绝了此操作" };
      return rawExecutors.deleteFile(args);
    },
  };

  return {
    ...safeTools,
    writeFile: guardedWriteFile,
    moveFile: guardedMoveFile,
    deleteFile: guardedDeleteFile,
  };
};

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
      console.log("[Main] Available controllers:", Array.from(abortControllers.keys()));

      // Set manual stop flag first
      manualStopFlags.set(payload.taskId, true);

      const controller = abortControllers.get(payload.taskId);
      if (controller) {
        console.log("[Main] Found controller, calling abort()");
        console.log("[Main] Controller aborted signal before abort():", controller.signal.aborted);
        controller.abort();
        console.log("[Main] Controller aborted signal after abort():", controller.signal.aborted);
        console.log("[Main] Set manual stop flag for taskId:", payload.taskId);
        abortControllers.delete(payload.taskId);
        console.log("[Main] Successfully aborted and removed controller");

        // Add fallback timeout to force stream completion
        setTimeout(() => {
          if (manualStopFlags.has(payload.taskId)) {
            console.log("[Main] Timeout fallback: forcing stream completion for taskId:", payload.taskId);

            // Clean up pending tool approvals for this specific task
            const toolCallsToReject: string[] = [];
            toolCallToTaskMap.forEach((taskId, toolCallId) => {
              if (taskId === payload.taskId) {
                console.log("[Main] Rejecting pending tool approval for stopped task:", toolCallId);
                const resolve = pendingApprovals.get(toolCallId);
                if (resolve) {
                  resolve(false); // Reject pending approvals
                  toolCallsToReject.push(toolCallId);
                }
              }
            });
            toolCallsToReject.forEach(id => {
              pendingApprovals.delete(id);
              toolCallToTaskMap.delete(id);
            });

            // Try to send stream-done event as fallback
            const windows = require("electron").BrowserWindow.getAllWindows();
            if (windows.length > 0) {
              windows[0].webContents.send("ai:stream-done", { id: payload.taskId });
            }
            manualStopFlags.delete(payload.taskId);
          }
        }, 1000); // 1 second timeout
      } else {
        console.warn("[Main] No controller found for taskId:", payload.taskId);
        console.log("[Main] Set manual stop flag anyway for taskId:", payload.taskId);
      }
      return { ok: true };
    },
  );

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

  // -----------------------------------------------------------------------
  // Planner IPC handlers
  // -----------------------------------------------------------------------

  /** Pending plans waiting for user approval */
  const pendingPlans = new Map<string, Plan>();

  /** Check if a prompt needs planning (used by renderer to decide UI flow) */
  ipcMain.handle(
    "ai:checkNeedsPlanning",
    async (_event, payload: { prompt: string }) => {
      return { needsPlanning: needsPlanning(payload.prompt) };
    },
  );

  /** Generate a plan without executing it */
  ipcMain.handle(
    "ai:generatePlan",
    async (event, payload: { prompt: string; workspacePath: string; llmConfigId?: string }) => {
      const sender = event.sender;
      try {
        if (!sender.isDestroyed()) {
          sender.send("ai:plan-generating", { prompt: payload.prompt });
        }

        const model = getAIModelByConfigId(payload.llmConfigId);
        // Plan phase uses only read-only tools — no side effects
        const readOnlyTools: Record<string, Tool> = {
          listDirectory: safeTools.listDirectory,
          readFile: safeTools.readFile,
          directoryStats: safeTools.directoryStats,
        };

        const plan = await planTask(
          payload.prompt,
          payload.workspacePath,
          model,
          readOnlyTools,
        );

        pendingPlans.set(plan.id, plan);

        if (!sender.isDestroyed()) {
          sender.send("ai:plan-ready", { plan });
        }

        return { plan };
      } catch (error: unknown) {
        const errorMsg = isAuthError(error)
          ? "API Key 无效或已过期，请在设置中检查该渠道配置"
          : error instanceof Error ? error.message : "Unknown error";
        if (!sender.isDestroyed()) {
          sender.send("ai:plan-error", { error: errorMsg });
        }
        return { error: errorMsg };
      }
    },
  );

  /** User approved a plan — execute it */
  ipcMain.handle(
    "ai:approvePlan",
    async (event, payload: { planId: string; llmConfigId?: string }) => {
      const plan = pendingPlans.get(payload.planId);
      if (!plan) return { error: "Plan not found" };
      pendingPlans.delete(payload.planId);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const sender = event.sender;

      addTask({
        id,
        workspaceId: "default",
        prompt: plan.prompt,
        status: "running",
        result: null,
        filesAffected: null,
        createdAt: now,
        completedAt: null,
      });

      // Create AbortController for this plan execution
      const controller = new AbortController();
      console.log("[Main] Created AbortController for plan taskId:", id);
      abortControllers.set(id, controller);

      try {
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-start", { id });
        }

        const model = getAIModelByConfigId(payload.llmConfigId);
        const tools = buildTools(sender, id);

        plan.status = "approved";
        const finalPlan = await executePlan({
          plan,
          model,
          tools,
          sender,
          taskId: id,
          abortSignal: controller.signal,
        });

        updateTask(id, {
          status: finalPlan.status === "completed" ? "completed" : "failed",
          result: finalPlan.goal,
          completedAt: new Date().toISOString(),
        });

        if (!sender.isDestroyed()) {
          sender.send("ai:stream-done", { id });
        }

        return { id, status: finalPlan.status };
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          // User-initiated abort — treat as normal completion
          console.log("[Main] Plan AbortError caught, cleaning up for taskId:", id);
          updateTask(id, { status: "completed", result: plan.goal, completedAt: new Date().toISOString() });
          if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
          // Clean up AbortController immediately
          abortControllers.delete(id);
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
        abortControllers.delete(id);
      }
    },
  );

  /** User rejected a plan */
  ipcMain.handle(
    "ai:rejectPlan",
    async (_event, payload: { planId: string }) => {
      pendingPlans.delete(payload.planId);
      return { ok: true };
    },
  );

  /** Cancel a running plan */
  ipcMain.handle(
    "ai:cancelPlan",
    async (_event, payload: { planId: string }) => {
      cancelPlan(payload.planId);
      return { ok: true };
    },
  );

  // -----------------------------------------------------------------------
  // Task execution (original direct path + planner-aware routing)
  // -----------------------------------------------------------------------

  ipcMain.handle(
    "ai:executeTask",
    async (event, payload: { prompt: string; workspacePath: string; llmConfigId?: string; history?: Array<{ role: string; content: string; parts?: unknown[] }> }) => {
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

      try {
        // Notify renderer of the task id before streaming starts
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-start", { id });
        }

        const model = getAIModelByConfigId(payload.llmConfigId);

        // ── Skill matching: /command format first, then prompt-based ──
        let skill: UnifiedSkill | undefined;
        let skillArgs = "";

        if (payload.prompt.startsWith("/")) {
          const spaceIdx = payload.prompt.indexOf(" ");
          const command = spaceIdx > 0 ? payload.prompt.slice(0, spaceIdx) : payload.prompt;
          skillArgs = spaceIdx > 0 ? payload.prompt.slice(spaceIdx + 1) : "";
          skill = skillRegistry.matchByCommand(command);
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
            const tools = buildTools(sender, id);
            const deps: ExecutorDeps = {
              getModel: () => getAIModelByConfigId(payload.llmConfigId),
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
        const tools = buildTools(sender, id);
        const skillTools = skill?.tools ?? {};

        const system = `You are FileWork, a local file management AI assistant. You help users organize, analyze, and manage files in their directories.

Current workspace: ${payload.workspacePath}

Rules:
- Always use absolute paths based on the workspace path provided.
- Before making changes, list the directory to understand the current structure.
- Explain what you did after completing the task.
- Be careful with delete operations — confirm the scope is correct.
- Respond in the same language as the user's prompt.${skillPrompt}`;

        // ── Build messages from history (if available) ──
        const useMessagesMode = !!convertedHistory?.length;
        const builtMessages: import("ai").ModelMessage[] = useMessagesMode
          ? [...convertedHistory!, { role: "user" as const, content: payload.prompt }]
          : [];

        // AbortController already created and registered above

        const result = useMessagesMode
          ? streamText({
              model,
              tools: { ...tools, ...skillTools },
              stopWhen: stepCountIs(20),
              system,
              messages: builtMessages,
              abortSignal: controller.signal,
            })
          : streamText({
              model,
              tools: { ...tools, ...skillTools },
              stopWhen: stepCountIs(20),
              system,
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

            // Check if manual stop flag was set
            if (manualStopFlags.get(id)) {
              console.log("[Main] Manual stop flag detected in stream loop for taskId:", id);
              break;
            }

            // Check if abort signal was triggered
            if (controller.signal.aborted) {
              console.log("[Main] Abort signal detected in stream loop for taskId:", id);
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
          console.log("[Main] Stream loop ended for taskId:", id, "total parts processed:", partCount);
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError") {
            // User-initiated abort — treat as normal completion
            console.log("[Main] AbortError caught, cleaning up for taskId:", id);
            updateTask(id, { status: "completed", result: fullText, completedAt: new Date().toISOString() });
            if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
            // Clean up AbortController and stop flag immediately
            abortControllers.delete(id);
            manualStopFlags.delete(id);

            // Clean up any pending tool calls for this task
            const toolCallsToClean: string[] = [];
            toolCallToTaskMap.forEach((taskId, toolCallId) => {
              if (taskId === id) {
                toolCallsToClean.push(toolCallId);
              }
            });
            toolCallsToClean.forEach(toolCallId => {
              pendingApprovals.delete(toolCallId);
              toolCallToTaskMap.delete(toolCallId);
            });

            return { id, status: "completed" };
          }
          throw error;
        } finally {
          console.log("[Main] Cleaning up AbortController for taskId:", id);
          abortControllers.delete(id);
          manualStopFlags.delete(id);

          // Clean up any pending tool calls for this task
          const toolCallsToClean: string[] = [];
          toolCallToTaskMap.forEach((taskId, toolCallId) => {
            if (taskId === id) {
              toolCallsToClean.push(toolCallId);
            }
          });
          toolCallsToClean.forEach(toolCallId => {
            pendingApprovals.delete(toolCallId);
            toolCallToTaskMap.delete(toolCallId);
          });
        }

        updateTask(id, {
          status: "completed",
          result: fullText,
          completedAt: new Date().toISOString(),
        });

        if (!sender.isDestroyed()) {
          sender.send("ai:stream-done", { id });
        }

        return { id, status: "completed" };
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

        // Cleanup AbortController and stop flag on error
        console.log("[Main] Cleaning up AbortController on error for taskId:", id);
        abortControllers.delete(id);
        manualStopFlags.delete(id);

        // Clean up any pending tool calls for this task
        const toolCallsToClean: string[] = [];
        toolCallToTaskMap.forEach((taskId, toolCallId) => {
          if (taskId === id) {
            toolCallsToClean.push(toolCallId);
          }
        });
        toolCallsToClean.forEach(toolCallId => {
          pendingApprovals.delete(toolCallId);
          toolCallToTaskMap.delete(toolCallId);
        });

        return { id, status: "failed", message: errorMsg };
      }
    },
  );
};
