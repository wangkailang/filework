/**
 * AI Tools Definition and Management
 *
 * Contains safe and dangerous tools with their implementations,
 * approval mechanisms, and execution logic.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Tool } from "ai";
import { z } from "zod/v4";
import {
  pendingApprovals,
  toolCallToTaskMap,
  activeToolExecutions,
  initTaskExecution,
} from "./ai-task-control";
import { getIncrementalScanner, type FileEntry } from "../utils/incremental-scanner";

const pathSchema = z.object({ path: z.string().describe("Absolute path") });

const sortFileEntries = (entries: FileEntry[]): FileEntry[] =>
  [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

/** Human-readable descriptions for dangerous operations */
export const dangerousToolDescriptions: Record<string, (args: Record<string, unknown>) => string> = {
  deleteFile: (args) => `删除 ${args.path}`,
  writeFile: (args) => `写入文件 ${args.path}`,
  moveFile: (args) => `移动 ${args.source} → ${args.destination}`,
  clearDirectoryCache: (args) => args.path ? `清理目录缓存 ${args.path}` : "清理所有目录缓存",
};

/** Raw execute functions for dangerous tools (without approval guard) */
export const rawExecutors = {
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
export const safeTools: Record<string, Tool> = {
  listDirectory: {
    description: "List files and directories at the given path with incremental scanning support",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to directory"),
      incremental: z.boolean().optional().default(true).describe("Use incremental scanning (default: true)"),
      forceRescan: z.boolean().optional().default(false).describe("Force full rescan ignoring cache"),
      includeStats: z.boolean().optional().default(false).describe("Include scan statistics in response"),
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
        const sortedResults = sortFileEntries(results);
        return includeStats
          ? { files: sortedResults, stats: { incremental: false, totalFiles: sortedResults.length } }
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
      return content.length > 50000 ? `${content.slice(0, 50000)}\\n...(truncated)` : content;
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
      cwd: z.string().optional().describe("Working directory (defaults to workspace path)"),
    }),
    execute: async ({ command, cwd }: { command: string; cwd?: string }, { abortSignal }) => {
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        // Use shell: true to properly handle quoted arguments, pipes, and shell syntax
        const child = spawn(command, [], {
          cwd: cwd || process.cwd(),
          shell: true,
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
          resolve({ stdout, stderr, exitCode: code || 0 });
        });

        child.on("error", (error) => {
          reject(error);
        });

        // Handle abort signal
        if (abortSignal) {
          const onAbort = () => {
            console.log("[Tool] Aborting runCommand:", command);

            try {
              // Enhanced process termination
              if (child.pid) {
                // Try SIGTERM first
                process.kill(child.pid, "SIGTERM");

                // Force kill after 2 seconds
                setTimeout(() => {
                  try {
                    if (child.pid) {
                      process.kill(child.pid, "SIGKILL");
                      // Also try to kill process tree for complex commands like npx
                      try {
                        spawn("pkill", ["-P", child.pid.toString()]);
                      } catch (err) {
                        // Process may already be dead
                      }
                    }
                  } catch (err) {
                    // Process may already be dead
                  }
                }, 2000);
              }

            } catch (err) {
              console.error("[Tool] Process termination failed:", err);
            }

            resolve({
              stdout,
              stderr: stderr + "\\nCommand was cancelled",
              exitCode: 130, // Standard exit code for SIGTERM
            });
          };

          if (abortSignal.aborted) {
            onAbort();
          } else {
            abortSignal.addEventListener('abort', onAbort, { once: true });
          }
        }
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
          // skip inaccessible
        }
      }
      return { totalFiles, totalDirs, totalSize, extensions };
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
 * Stateful tools that should not be exposed by default.
 * These tools mutate in-memory/runtime state and require explicit opt-in.
 */
export const statefulTools: Record<string, Tool> = {
  clearDirectoryCache: {
    description: "Clear incremental scanning cache for a directory or all directories (stateful operation)",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory path to clear cache for (optional, clears all if not provided)"),
    }),
    execute: async ({ path: dirPath }: { path?: string }) => {
      const scanner = getIncrementalScanner();
      await scanner.clearCache(dirPath);
      return {
        success: true,
        message: dirPath ? `Cache cleared for ${dirPath}` : "All cache cleared",
        path: dirPath,
      };
    },
  },
};

/**
 * Request approval from the renderer and wait for the response
 */
export const requestApproval = (
  sender: Electron.WebContents,
  taskId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
  abortSignal?: AbortSignal,
): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(toolCallId, resolve);
    toolCallToTaskMap.set(toolCallId, taskId);

    // Handle abort signal
    if (abortSignal) {
      const onAbort = () => {
        console.log("[Tool] Aborting tool approval request:", toolCallId);
        pendingApprovals.delete(toolCallId);
        toolCallToTaskMap.delete(toolCallId);
        resolve(false); // Deny approval on abort
      };

      if (abortSignal.aborted) {
        onAbort();
        return;
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
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
      });
    }
  });
};

/**
 * Wrap a tool with task-level abort control
 */
export const wrapToolWithAbort = (originalTool: Tool, taskId: string): Tool => ({
  ...originalTool,
  execute: async (args: any, context: any) => {
    // Create a combined AbortController that responds to both:
    // 1. The original abortSignal from AI SDK
    // 2. Our manual task cancellation
    const taskAbortController = new AbortController();

    // Register the controller IMMEDIATELY when tool execution starts
    const taskControllers = activeToolExecutions.get(taskId);
    if (taskControllers) {
      taskControllers.add(taskAbortController);
      console.log(`[Tool] Registered abort controller for task ${taskId}, total active:`, taskControllers.size);
    } else {
      console.warn(`[Tool] No active execution tracking found for task ${taskId}`);
    }

    // Create combined abort signal (fallback for older Node.js versions)
    let combinedSignal: AbortSignal;
    if (typeof AbortSignal.any === 'function') {
      combinedSignal = AbortSignal.any([context.abortSignal, taskAbortController.signal]);
    } else {
      // Fallback: create a new controller that responds to either signal
      const combinedController = new AbortController();

      const abortHandler = () => {
        if (!combinedController.signal.aborted) {
          combinedController.abort();
        }
      };

      if (context.abortSignal?.aborted || taskAbortController.signal.aborted) {
        combinedController.abort();
      } else {
        context.abortSignal?.addEventListener('abort', abortHandler, { once: true });
        taskAbortController.signal.addEventListener('abort', abortHandler, { once: true });
      }

      combinedSignal = combinedController.signal;
    }

    try {
      console.log(`[Tool] Starting execution for task ${taskId}, tool: ${originalTool.description?.substring(0, 50) || 'unknown'}`);
      console.log(`[Tool] Current active tools for task ${taskId}:`, taskControllers?.size || 0);
      console.log(`[Tool] Tool args:`, JSON.stringify(args).substring(0, 100));

      const result = await originalTool.execute?.(args, { ...context, abortSignal: combinedSignal });

      console.log(`[Tool] Completed execution for task ${taskId}, result:`, JSON.stringify(result).substring(0, 100));
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log(`[Tool] Tool execution aborted for task ${taskId}`);
        return { success: false, cancelled: true, reason: "工具执行被取消" };
      }
      throw error;
    } finally {
      // Clean up the task controller
      if (taskControllers) {
        taskControllers.delete(taskAbortController);
        console.log(`[Tool] Unregistered abort controller for task ${taskId}, remaining active:`, taskControllers.size);
      }
    }
  }
});
