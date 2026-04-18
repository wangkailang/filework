/**
 * AI Tool Permission Management
 *
 * Handles building tool sets based on skill configurations,
 * enforcing tool restrictions, and managing skill-specific permissions.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "ai";
import { z } from "zod/v4";
import { getPlanApprovedWorkspace, initTaskExecution } from "./ai-task-control";
import {
  rawExecutors,
  requestApproval,
  safeTools,
  statefulTools,
  wrapToolWithAbort,
} from "./ai-tools";

const pathSchema = z.object({ path: z.string().describe("Absolute path") });

/**
 * Check if a writeFile call can be auto-approved for a plan-approved task.
 * Resolves symlinks via fs.realpath to prevent workspace-escape writes.
 * For new files (target doesn't exist yet), validates the parent directory.
 */
const canAutoApproveWrite = async (
  taskId: string,
  filePath: string,
): Promise<boolean> => {
  const workspace = getPlanApprovedWorkspace(taskId);
  if (!workspace) return false;

  try {
    const realWorkspace = await realpath(workspace);

    // Try resolving the target itself; if it doesn't exist, resolve its parent
    let realTarget: string;
    try {
      realTarget = await realpath(filePath);
    } catch {
      // File doesn't exist yet — resolve parent directory instead
      const parentDir = path.dirname(path.resolve(filePath));
      try {
        realTarget = path.join(await realpath(parentDir), path.basename(filePath));
      } catch {
        // Parent doesn't exist either — reject (mkdir will create it, but we
        // can't verify the real path ahead of time)
        return false;
      }
    }

    return (
      realTarget.startsWith(realWorkspace + path.sep) ||
      realTarget === realWorkspace
    );
  } catch {
    // Workspace path itself can't be resolved — reject
    return false;
  }
};

/**
 * Auto-approve a writeFile call if the task is plan-approved and the path is in workspace.
 * Returns the write result if auto-approved, or null to fall through to manual approval.
 */
const tryAutoApproveWrite = async (
  taskId: string,
  sender: Electron.WebContents,
  toolCallId: string,
  args: { path: string; content: string },
): Promise<unknown | null> => {
  if (!(await canAutoApproveWrite(taskId, args.path))) return null;
  console.log(
    `[Tool] Auto-approved writeFile for plan task ${taskId}: ${args.path}`,
  );
  if (!sender.isDestroyed()) {
    sender.send("ai:tool-auto-approved", {
      id: taskId,
      toolCallId,
      toolName: "writeFile",
      path: args.path,
    });
  }
  return rawExecutors.writeFile(args);
};

/**
 * Build skill-specific tools based on allowed-tools configuration.
 * Only includes tools explicitly allowed by the skill.
 */
export const buildSkillSpecificTools = (
  allowedTools: string[],
  sender: Electron.WebContents,
  taskId: string,
): Record<string, Tool> => {
  // Initialize tool execution tracking for this task
  initTaskExecution(taskId);

  // Only build tools that are explicitly allowed
  const skillTools: Record<string, Tool> = {};

  for (const toolName of allowedTools) {
    if (toolName === "writeFile") {
      skillTools.writeFile = wrapToolWithAbort(
        {
          description:
            "Write content to a file (creates or overwrites). Requires user approval.",
          inputSchema: z.object({
            path: z.string().describe("Absolute path to the file"),
            content: z.string().describe("Content to write"),
          }),
          execute: async (
            args: { path: string; content: string },
            { toolCallId, abortSignal },
          ) => {
            const autoResult = await tryAutoApproveWrite(taskId, sender, toolCallId, args);
            if (autoResult !== null) return autoResult;
            const approved = await requestApproval(
              sender,
              taskId,
              toolCallId,
              "writeFile",
              { path: args.path },
              abortSignal,
            );
            if (!approved)
              return {
                success: false,
                denied: true,
                reason: "用户拒绝了此操作",
              };
            return rawExecutors.writeFile(args);
          },
        },
        taskId,
      );
    } else if (toolName === "moveFile") {
      skillTools.moveFile = wrapToolWithAbort(
        {
          description:
            "Move or rename a file/directory. Requires user approval.",
          inputSchema: z.object({
            source: z.string().describe("Source absolute path"),
            destination: z.string().describe("Destination absolute path"),
          }),
          execute: async (
            args: { source: string; destination: string },
            { toolCallId, abortSignal },
          ) => {
            const approved = await requestApproval(
              sender,
              taskId,
              toolCallId,
              "moveFile",
              args,
              abortSignal,
            );
            if (!approved)
              return {
                success: false,
                denied: true,
                reason: "用户拒绝了此操作",
              };
            return rawExecutors.moveFile(args);
          },
        },
        taskId,
      );
    } else if (toolName === "deleteFile") {
      skillTools.deleteFile = wrapToolWithAbort(
        {
          description: "Delete a file or directory. Requires user approval.",
          inputSchema: pathSchema,
          execute: async (
            args: { path: string },
            { toolCallId, abortSignal },
          ) => {
            const approved = await requestApproval(
              sender,
              taskId,
              toolCallId,
              "deleteFile",
              args,
              abortSignal,
            );
            if (!approved)
              return {
                success: false,
                denied: true,
                reason: "用户拒绝了此操作",
              };
            return rawExecutors.deleteFile(args);
          },
        },
        taskId,
      );
    } else if (safeTools[toolName]) {
      skillTools[toolName] = wrapToolWithAbort(safeTools[toolName], taskId);
    } else if (
      toolName === "clearDirectoryCache" &&
      statefulTools.clearDirectoryCache
    ) {
      skillTools.clearDirectoryCache = wrapToolWithAbort(
        {
          ...statefulTools.clearDirectoryCache,
          execute: async (
            args: { path?: string },
            { toolCallId, abortSignal },
          ) => {
            const approved = await requestApproval(
              sender,
              taskId,
              toolCallId,
              "clearDirectoryCache",
              args,
              abortSignal,
            );
            if (!approved)
              return {
                success: false,
                denied: true,
                reason: "用户拒绝了此操作",
              };
            return statefulTools.clearDirectoryCache.execute?.(args, {
              toolCallId,
              abortSignal,
            } as any);
          },
        },
        taskId,
      );
    }
  }

  console.log(
    `[Skill Tools] Built ${Object.keys(skillTools).length} tools for skill:`,
    allowedTools,
  );
  return skillTools;
};

/**
 * Build the full tool set for a specific request.
 * Dangerous tools are wrapped with an approval guard that pauses execution
 * until the user approves or rejects via the renderer.
 */
export const buildTools = (
  sender: Electron.WebContents,
  taskId: string,
): Record<string, Tool> => {
  // Initialize tool execution tracking for this task
  initTaskExecution(taskId);

  const guardedWriteFile: Tool = wrapToolWithAbort(
    {
      description:
        "Write content to a file (creates or overwrites). Requires user approval.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file"),
        content: z.string().describe("Content to write"),
      }),
      execute: async (
        args: { path: string; content: string },
        { toolCallId, abortSignal },
      ) => {
        const autoResult = await tryAutoApproveWrite(taskId, sender, toolCallId, args);
        if (autoResult !== null) return autoResult;
        const approved = await requestApproval(
          sender,
          taskId,
          toolCallId,
          "writeFile",
          { path: args.path },
          abortSignal,
        );
        if (!approved)
          return { success: false, denied: true, reason: "用户拒绝了此操作" };
        return rawExecutors.writeFile(args);
      },
    },
    taskId,
  );

  const guardedMoveFile: Tool = wrapToolWithAbort(
    {
      description: "Move or rename a file/directory. Requires user approval.",
      inputSchema: z.object({
        source: z.string().describe("Source absolute path"),
        destination: z.string().describe("Destination absolute path"),
      }),
      execute: async (
        args: { source: string; destination: string },
        { toolCallId, abortSignal },
      ) => {
        const approved = await requestApproval(
          sender,
          taskId,
          toolCallId,
          "moveFile",
          args,
          abortSignal,
        );
        if (!approved)
          return { success: false, denied: true, reason: "用户拒绝了此操作" };
        return rawExecutors.moveFile(args);
      },
    },
    taskId,
  );

  const guardedDeleteFile: Tool = wrapToolWithAbort(
    {
      description: "Delete a file or directory. Requires user approval.",
      inputSchema: pathSchema,
      execute: async (args: { path: string }, { toolCallId, abortSignal }) => {
        const approved = await requestApproval(
          sender,
          taskId,
          toolCallId,
          "deleteFile",
          args,
          abortSignal,
        );
        if (!approved)
          return { success: false, denied: true, reason: "用户拒绝了此操作" };
        return rawExecutors.deleteFile(args);
      },
    },
    taskId,
  );

  // Wrap all safe tools with abort tracking as well
  const wrappedSafeTools: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(safeTools)) {
    wrappedSafeTools[name] = wrapToolWithAbort(tool, taskId);
  }

  return {
    ...wrappedSafeTools,
    writeFile: guardedWriteFile,
    moveFile: guardedMoveFile,
    deleteFile: guardedDeleteFile,
  };
};
