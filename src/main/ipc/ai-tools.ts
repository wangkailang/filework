/**
 * AI 工具定义与管理
 *
 * 当前导出：
 *   - `safeTools`：只读工具实现，由 `ai-plan-handlers`
 *     （计划生成的只读工具）以及 `ai-tools.test.ts`
 *     的单元测试使用
 *   - `requestApproval`：`approval-hook.ts` 使用的 IPC 审批原语
 *   - `dangerousToolDescriptions`：本地化的 prompt 字符串，
 *     由 `requestApproval` 内部使用
 *
 * 在 M2 之前，本文件还导出过 `rawExecutors`、`statefulTools` 与
 * `wrapToolWithAbort` —— 均已在 M2 PR 4 中删除，因为它们唯一的
 * 使用方（`ai-tool-permissions.ts`）在 AgentLoop 迁移后已被
 * `core/agent/tools/*` + `agent-tools.ts` + `approval-hook.ts` 取代并删除。
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
import { enqueueForBatch } from "./approval-batcher";
import { isToolPersistentlyWhitelisted } from "./tool-whitelist";

const pathSchema = z.object({ path: z.string().describe("Absolute path") });

const sortFileEntries = (entries: FileEntry[]): FileEntry[] =>
  [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

/** 危险操作的可读描述 */
export const dangerousToolDescriptions: Record<
  string,
  (args: Record<string, unknown>) => string
> = {
  deleteFile: (args) => `删除 ${args.path}(移入回收站,可恢复)`,
  emptyTrash: (args) =>
    args.id ? `永久清除回收站项 ${args.id}` : "永久清空回收站(不可恢复)",
  writeFile: (args) => `写入文件 ${args.path}`,
  moveFile: (args) => `移动 ${args.source} → ${args.destination}`,
  clearDirectoryCache: (args) =>
    args.path ? `清理目录缓存 ${args.path}` : "清理所有目录缓存",
  runCommand: (args) => `运行命令 ${String(args.command).slice(0, 120)}`,
};

/** 需要审批的危险工具名——白名单管理面板据此列出可「始终允许」的工具。 */
export const dangerousToolNames: string[] = Object.keys(
  dangerousToolDescriptions,
);

/** 安全（只读）工具 —— 在所有请求间共享 */
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
        // 仅在显式禁用增量扫描时才使用原始实现
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
            // 跳过无法访问的项
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

      // 使用增量扫描
      const scanner = getIncrementalScanner();
      const scanResult = await scanner.scanIncremental(dirPath, forceRescan);

      // 合并所有文件（新增 + 修改 + 未变更）
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
              // detached 子进程拥有自己的进程组。杀掉整个进程组。
              if (process.platform !== "win32") {
                process.kill(-child.pid, signal);
              } else {
                // /T 杀掉子进程树，/F 强制结束。
                spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                  stdio: "ignore",
                  windowsHide: true,
                });
              }
            } catch {
              // 当进程组终止不可用时，回退为直接按 pid 终止。
              try {
                process.kill(child.pid, signal);
              } catch {
                // 进程可能已经退出。
              }
            }
          };

          // 使用 shell: true 以正确处理带引号的参数、管道与 shell 语法
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

          // 处理 abort 信号
          if (abortSignal) {
            const onAbort = () => {
              console.log("[Tool] Aborting runCommand:", command);

              try {
                terminateProcessTree("SIGTERM");
                // 宽限期后强制终止，以防进程忽略 SIGTERM。
                killTimer = setTimeout(() => {
                  terminateProcessTree("SIGKILL");
                }, 2000);
              } catch (err) {
                console.error("[Tool] Process termination failed:", err);
              }

              settle({
                stdout,
                stderr: `${stderr}\\nCommand was cancelled`,
                exitCode: 130, // SIGTERM 的标准退出码
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
      "Count files and total size by extension (each type returns { count, totalSize in bytes }) plus overall totals. Use this for any 'count / size by type' aggregation — never tally a listDirectory dump by hand.",
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
      // 按扩展名统计数量与大小，让模型直接转述一张算好的表，
      // 而不是按类型手动累加大小（它在这一步容易出错）。
      const extensions: Record<string, { count: number; totalSize: number }> =
        {};
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
            extensions[ext] ??= { count: 0, totalSize: 0 };
            const bucket = extensions[ext];
            bucket.count++;
            bucket.totalSize += s.size;
          }
        } catch {
          // 跳过无法访问的项
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
 * 向渲染层请求审批并等待其响应
 */
export const requestApproval = (
  sender: Electron.WebContents,
  taskId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
  abortSignal?: AbortSignal,
  workspace?: import("../core/workspace/types").Workspace,
): Promise<boolean> => {
  // 工具已在持久白名单里(用户选过「始终允许」或在设置里开启)→ 跳过审批。
  if (isToolPersistentlyWhitelisted(toolName)) {
    console.log(
      `[Tool] Auto-approved ${toolName} via persistent whitelist for taskId: ${taskId}`,
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

  // 所有破坏性工具按 (task, toolName) 合并为单张审批卡片，
  // 这样一波 N 个并发的 deleteFile 调用只需点击 1 次而非 N 次。
  // 普通批准只放行卡片里显示的操作;白名单(后续自动
  // 放行)仅在用户显式选「始终允许」时由 settleBatch 写入,这里不再自动写。
  const describeFn = dangerousToolDescriptions[toolName];
  const description = describeFn
    ? describeFn(args as Record<string, unknown>)
    : toolName;
  return enqueueForBatch({
    sender,
    taskId,
    toolName,
    toolCallId,
    args,
    description,
    abortSignal,
    workspace,
  });
};

// `wrapToolWithAbort` 已在 M2 PR 4 中连同其唯一调用方
// （`buildTools` / `buildSkillSpecificTools`）一起删除。逐次调用的 abort
// 跟踪现在位于 AgentLoop 的工具注册表（`core/agent/tool-registry.ts`）内，
// 而 IPC 转换层直接发出 task-trace 的 `tool-start` / `tool-end` 事件
// （`ai-handlers.ts`）。
