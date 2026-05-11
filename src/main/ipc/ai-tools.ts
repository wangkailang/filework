/**
 * AI Tools Definition and Management
 *
 * Currently exports:
 *   - `safeTools`: read-only tool implementations consumed by
 *     `ai-plan-handlers` (plan-generation read-only tools) and by
 *     `ai-tools.test.ts` for unit coverage
 *   - `requestApproval`: IPC approval primitive used by `approval-hook.ts`
 *   - `dangerousToolDescriptions`: localized prompt strings, consumed
 *     internally by `requestApproval`
 *
 * Pre-M2 the file also exported `rawExecutors`, `statefulTools`, and
 * `wrapToolWithAbort` — all deleted in M2 PR 4 because their only
 * consumer (`ai-tool-permissions.ts`) was itself deleted after the
 * AgentLoop migration replaced it with `core/agent/tools/*` +
 * `agent-tools.ts` + `approval-hook.ts`.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Tool } from "ai";
import { z } from "zod/v4";
import {
  type FileEntry,
  getIncrementalScanner,
} from "../utils/incremental-scanner";
import {
  isToolWhitelistedForTask,
  pendingApprovals,
  toolCallToTaskMap,
  whitelistToolForTask,
} from "./ai-task-control";

const pathSchema = z.object({ path: z.string().describe("Absolute path") });

const sortFileEntries = (entries: FileEntry[]): FileEntry[] =>
  [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

/**
 * Tools that always require explicit approval — even after the user has
 * approved them once in this task. Reserved for actions with broad
 * remote effects (push, PR open, posting public comments) where silent
 * re-approval would be surprising. Local-only destructive tools
 * (writeFile, deleteFile, etc.) follow the whitelist-after-first-ok
 * pattern instead.
 */
const ALWAYS_PROMPT_TOOLS: ReadonlySet<string> = new Set([
  "gitPush",
  "openPullRequest",
  "githubCommentIssue",
  "githubCommentPullRequest",
  "gitlabCommentIssue",
  "gitlabCommentMergeRequest",
  // M9: re-runs consume CI minutes and may re-trigger deploys.
  "githubRerunWorkflowRun",
  "githubRerunFailedJobs",
  "gitlabRetryPipeline",
]);

/** Human-readable descriptions for dangerous operations */
export const dangerousToolDescriptions: Record<
  string,
  (args: Record<string, unknown>) => string
> = {
  deleteFile: (args) => `删除 ${args.path}`,
  writeFile: (args) => `写入文件 ${args.path}`,
  moveFile: (args) => `移动 ${args.source} → ${args.destination}`,
  clearDirectoryCache: (args) =>
    args.path ? `清理目录缓存 ${args.path}` : "清理所有目录缓存",
  runCommand: (args) => `运行命令 ${String(args.command).slice(0, 120)}`,
  gitCommit: (args) => `提交: ${String(args.message ?? "").slice(0, 80)}`,
  gitPush: (args) =>
    args.force ? "推送 (force-with-lease) 到 origin" : "推送到 origin",
  openPullRequest: (args) =>
    `创建 PR: ${String(args.title ?? "").slice(0, 80)}`,
  githubCommentIssue: (args) =>
    `评论 issue #${args.number}: ${String(args.body ?? "").slice(0, 60)}`,
  githubCommentPullRequest: (args) =>
    `评论 PR #${args.number}: ${String(args.body ?? "").slice(0, 60)}`,
  gitlabCommentIssue: (args) =>
    `评论 issue !${args.number}: ${String(args.body ?? "").slice(0, 60)}`,
  gitlabCommentMergeRequest: (args) =>
    `评论 MR !${args.number}: ${String(args.body ?? "").slice(0, 60)}`,
  githubRerunWorkflowRun: (args) => `重新运行整个 workflow run #${args.runId}`,
  githubRerunFailedJobs: (args) =>
    `仅重新运行 workflow run #${args.runId} 的失败 jobs`,
  gitlabRetryPipeline: (args) => `重试 pipeline #${args.runId} 的失败 jobs`,
};

/** Safe (read-only) tools — shared across all requests */
export const safeTools: Record<string, Tool> = {
  listDirectory: {
    description:
      "List files and directories at the given path with incremental scanning support",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to directory"),
      incremental: z
        .boolean()
        .optional()
        .default(true)
        .describe("Use incremental scanning (default: true)"),
      forceRescan: z
        .boolean()
        .optional()
        .default(false)
        .describe("Force full rescan ignoring cache"),
      includeStats: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include scan statistics in response"),
    }),
    execute: async ({
      path: dirPath,
      incremental = true,
      forceRescan = false,
      includeStats = false,
    }: {
      path: string;
      incremental?: boolean;
      forceRescan?: boolean;
      includeStats?: boolean;
    }) => {
      if (!incremental) {
        // Use original implementation only when incremental scanning is explicitly disabled
        const entries = await readdir(dirPath, { withFileTypes: true });
        const results: FileEntry[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
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
        const sortedResults = sortFileEntries(results);
        return includeStats
          ? {
              files: sortedResults,
              stats: { incremental: false, totalFiles: sortedResults.length },
            }
          : sortedResults;
      }

      // Use incremental scanning
      const scanner = getIncrementalScanner();
      const scanResult = await scanner.scanIncremental(dirPath, forceRescan);

      // Combine all files (added + modified + unchanged)
      const allFiles = [
        ...scanResult.added,
        ...scanResult.modified,
        ...scanResult.unchanged,
      ];
      const sortedFiles = sortFileEntries(allFiles);

      if (includeStats) {
        return {
          files: sortedFiles,
          stats: {
            incremental: true,
            totalFiles: scanResult.totalFiles,
            added: scanResult.added.length,
            modified: scanResult.modified.length,
            deleted: scanResult.deleted.length,
            unchanged: scanResult.unchanged.length,
            scanTime: scanResult.scanTime,
            cache: scanner.getCacheStats(),
          },
        };
      }

      return sortedFiles;
    },
  },

  readFile: {
    description: "Read the text content of a file",
    inputSchema: pathSchema,
    execute: async ({ path: filePath }: { path: string }) => {
      const content = await readFile(filePath, "utf-8");
      return content.length > 50000
        ? `${content.slice(0, 50000)}\\n...(truncated)`
        : content;
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
    description: "Execute a shell command (use with caution)",
    inputSchema: z.object({
      command: z.string().describe("The command to execute"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory (defaults to workspace path)"),
    }),
    execute: async (
      { command, cwd }: { command: string; cwd?: string },
      { abortSignal },
    ) => {
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve, reject) => {
          let settled = false;
          let killTimer: ReturnType<typeof setTimeout> | null = null;

          const settle = (
            value: { stdout: string; stderr: string; exitCode: number } | Error,
            asError = false,
          ) => {
            if (settled) return;
            settled = true;
            if (asError) {
              reject(value as Error);
            } else {
              resolve(
                value as { stdout: string; stderr: string; exitCode: number },
              );
            }
          };

          const terminateProcessTree = (signal: NodeJS.Signals) => {
            if (!child.pid) return;
            try {
              // Detached child gets its own process group. Kill the whole group.
              if (process.platform !== "win32") {
                process.kill(-child.pid, signal);
              } else {
                // /T kills child tree, /F force-kills.
                spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                  stdio: "ignore",
                  windowsHide: true,
                });
              }
            } catch {
              // Fallback to direct pid kill when process-group kill isn't available.
              try {
                process.kill(child.pid, signal);
              } catch {
                // Process may already be gone.
              }
            }
          };

          // Use shell: true to properly handle quoted arguments, pipes, and shell syntax
          const child = spawn(command, [], {
            cwd: cwd || process.cwd(),
            shell: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";

          child.stdout?.on("data", (data) => {
            stdout += data.toString();
          });

          child.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          child.on("close", (code) => {
            if (killTimer) {
              clearTimeout(killTimer);
              killTimer = null;
            }
            settle({ stdout, stderr, exitCode: code || 0 });
          });

          child.on("error", (error) => {
            settle(error, true);
          });

          // Handle abort signal
          if (abortSignal) {
            const onAbort = () => {
              console.log("[Tool] Aborting runCommand:", command);

              try {
                terminateProcessTree("SIGTERM");
                // Force kill after grace period in case process ignores SIGTERM.
                killTimer = setTimeout(() => {
                  terminateProcessTree("SIGKILL");
                }, 2000);
              } catch (err) {
                console.error("[Tool] Process termination failed:", err);
              }

              settle({
                stdout,
                stderr: `${stderr}\\nCommand was cancelled`,
                exitCode: 130, // Standard exit code for SIGTERM
              });
            };

            if (abortSignal.aborted) {
              onAbort();
            } else {
              abortSignal.addEventListener("abort", onAbort, { once: true });
            }
          }
        },
      );
    },
  },

  directoryStats: {
    description:
      "Get statistics about a directory (file count, size, extensions)",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to directory"),
      maxEntries: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50_000)
        .describe("Hard cap on scanned entries to avoid huge recursive walks"),
    }),
    execute: async ({
      path: dirPath,
      maxEntries = 50_000,
    }: {
      path: string;
      maxEntries?: number;
    }) => {
      const entries = await readdir(dirPath, {
        withFileTypes: true,
        recursive: true,
      });
      let totalFiles = 0;
      let totalDirs = 0;
      let totalSize = 0;
      const extensions: Record<string, number> = {};
      let scanned = 0;
      for (const entry of entries) {
        if (scanned >= maxEntries) break;
        scanned++;
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(entry.parentPath || dirPath, entry.name);
        if (
          fullPath.includes("/.filework/") ||
          fullPath.includes("/node_modules/")
        )
          continue;
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
          // skip inaccessible
        }
      }
      return {
        totalFiles,
        totalDirs,
        totalSize,
        extensions,
        scannedEntries: scanned,
        hitLimit: scanned >= maxEntries,
        maxEntries,
      };
    },
  },

  getCacheStats: {
    description: "Get statistics about the incremental scanning cache",
    inputSchema: z.object({}),
    execute: async () => {
      const scanner = getIncrementalScanner();
      const stats = scanner.getCacheStats();
      return {
        directories: stats.directories,
        totalFiles: stats.totalFiles,
        memoryUsage: `${Math.round(stats.memoryUsage / 1024)} KB`,
        memoryUsageBytes: stats.memoryUsage,
      };
    },
  },
};

/**
 * Request approval from the renderer and wait for the response
 */
/** Default approval timeout: 5 minutes */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export const requestApproval = (
  sender: Electron.WebContents,
  taskId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
  abortSignal?: AbortSignal,
  /**
   * Optional contextual warning rendered above the approval card.
   * M8 uses it to surface a failing-CI heads-up before openPullRequest.
   */
  extraContext?: string,
): Promise<boolean> => {
  // If the user already approved this tool type during the current task,
  // skip the approval prompt and auto-approve.
  if (isToolWhitelistedForTask(taskId, toolName)) {
    console.log(
      `[Tool] Auto-approved ${toolName} via task whitelist for taskId: ${taskId}`,
    );
    if (!sender.isDestroyed()) {
      sender.send("ai:tool-auto-approved", {
        id: taskId,
        toolCallId,
        toolName,
      });
    }
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = () => {
      console.log("[Tool] Aborting tool approval request:", toolCallId);
      settle(false);
    };
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      pendingApprovals.delete(toolCallId);
      toolCallToTaskMap.delete(toolCallId);
      // If approved, whitelist this tool type for the rest of the task —
      // EXCEPT for tools that are too remote-affecting to silently
      // re-approve (gitPush, openPullRequest). Those always re-prompt.
      if (approved && !ALWAYS_PROMPT_TOOLS.has(toolName)) {
        whitelistToolForTask(taskId, toolName);
      }
      resolve(approved);
    };

    pendingApprovals.set(toolCallId, settle);
    toolCallToTaskMap.set(toolCallId, taskId);

    // Auto-deny after timeout to prevent indefinite hang
    const timer = setTimeout(() => {
      if (!settled) {
        console.warn(
          `[Tool] Approval timeout (${APPROVAL_TIMEOUT_MS}ms) for ${toolName}, auto-denying:`,
          toolCallId,
        );
        if (!sender.isDestroyed()) {
          sender.send("ai:approval-timeout", {
            id: taskId,
            toolCallId,
            toolName,
            timeoutMs: APPROVAL_TIMEOUT_MS,
          });
        }
        settle(false);
      }
    }, APPROVAL_TIMEOUT_MS);

    // Handle abort signal
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

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
        extraContext,
      });
    }
  });
};

// `wrapToolWithAbort` was deleted in M2 PR 4 along with its only callers
// (`buildTools` / `buildSkillSpecificTools`). Per-call abort tracking now
// lives inside the AgentLoop's tool registry (`core/agent/tool-registry.ts`)
// and the IPC translator emits task-trace `tool-start` / `tool-end` events
// directly (`ai-handlers.ts`).
