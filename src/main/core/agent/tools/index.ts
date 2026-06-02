/**
 * 内置文件工具,符合 ToolRegistry 形态。
 *
 * 这些是 `src/main/ipc/ai-tools.ts` 中 `safeTools` / `rawExecutors` 的
 * M1 版替代实现。它们把每一次文件系统与 exec 调用都经由
 * `ctx.workspace.*` 路由,因此同一份工具实现可适配任何
 * `Workspace` 实现(当前是 LocalWorkspace,日后可接 GitHub/GitLab)。
 *
 * 工具的 inputSchema 仍然接受绝对路径(模型已在提示词与技能正文中
 * 按此训练)—— `resolveRel()` 会把它们转换为相对于 workspace 的形式,
 * 这意味着越出沙箱的绝对路径会从 `toRelative()` 抛出
 * `WorkspaceEscapeError`,而不是被悄悄拼接进去。
 */

import path from "node:path";
import { z } from "zod/v4";

import { isSandboxEffective, resolveWritableRoots } from "../../sandbox";
import type { SandboxConfig, SandboxPolicy } from "../../sandbox/types";
import type { Workspace } from "../../workspace/types";
import { computeWriteFilePreview } from "../preview/write-file";
import {
  killShell as killShellById,
  readShell,
  spawnBackgroundShell,
} from "../shells";
import type { ToolContext, ToolDefinition } from "../tool-registry";
import {
  classifyCommand,
  isDeliverableCommand,
  parseTestStats,
} from "./command-classify";

// ---------------------------------------------------------------------------
// 增量扫描的可选依赖(在 PR 2 中接入)
// ---------------------------------------------------------------------------

export interface IncrementalScanResult {
  totalFiles: number;
  added: WorkspaceEntryLike[];
  modified: WorkspaceEntryLike[];
  deleted: WorkspaceEntryLike[];
  unchanged: WorkspaceEntryLike[];
  scanTime: number;
}

export interface WorkspaceEntryLike {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

export interface IncrementalScannerLike {
  scanIncremental(
    absDir: string,
    forceRescan: boolean,
  ): Promise<IncrementalScanResult>;
  getCacheStats(): {
    directories: number;
    totalFiles: number;
    memoryUsage: number;
  };
  clearCache(absDir?: string): Promise<void>;
}

export interface FileToolsDeps {
  incrementalScanner?: IncrementalScannerLike;
  /**
   * 嵌入到 `runCommand` description 中的可选 git 工作流手册。当前活跃
   * workspace 由 git 支撑时,IPC 层(见
   * `system-prompt.buildGitRunCommandProtocol`)会构造该字符串,使 agent
   * 仅在考虑 shell 命令时才以高注意力权重获得 HEREDOC / `gh` / `glab`
   * 模板。非 git workspace 应将其保持为 undefined。
   */
  gitProtocol?: string;
  /**
   * 命令执行沙箱配置(来自用户设置)。提供则 `runCommand` 在 OS 沙箱内
   * 执行;不提供则裸调用(eval / fork 等无需沙箱的路径保持旧行为)。
   */
  sandbox?: SandboxConfig;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

async function resolveRel(workspace: Workspace, p: string): Promise<string> {
  if (path.isAbsolute(p)) {
    return workspace.fs.toRelative(p);
  }
  return p;
}

const sortEntries = (entries: WorkspaceEntryLike[]): WorkspaceEntryLike[] =>
  [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

// ---------------------------------------------------------------------------
// Schema 定义
// ---------------------------------------------------------------------------

const pathSchema = z.object({
  path: z.string().describe("Absolute path (or workspace-relative)"),
});

const listDirectorySchema = z.object({
  path: z.string().describe("Absolute path to directory"),
  incremental: z
    .boolean()
    .optional()
    .default(true)
    .describe("Use incremental scanning if available (default: true)"),
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
});

const writeFileSchema = z.object({
  path: z.string().describe("Absolute path to the file"),
  content: z.string().describe("Content to write"),
});

const moveFileSchema = z.object({
  source: z.string().describe("Source absolute path"),
  destination: z.string().describe("Destination absolute path"),
});

const runCommandSchema = z.object({
  command: z.string().describe("The command to execute"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory. Accepts any absolute path, including locations outside the workspace (pair with escalatePermissions for those). Defaults to the workspace root. Use this instead of `cd <dir> &&` in the command.",
    ),
  runInBackground: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true for any command that does not terminate on its own: dev servers (`*dev`, `*start`, `*serve`), watchers (`--watch`), TUIs, REPLs. Returns a shellId immediately with the first ~2s of output; use `readShellOutput` to poll for more and `killShell` to terminate.",
    ),
  escalatePermissions: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set true ONLY when the command genuinely needs to escape the sandbox: outbound network (npm/pip install, curl, git push) or writing outside the workspace. Triggers a user approval prompt; if approved the command runs WITHOUT the sandbox. Leave false for ordinary in-workspace work — sandboxed commands never need it.",
    ),
  justification: z
    .string()
    .optional()
    .describe(
      "One short sentence shown to the user explaining why escalatePermissions is needed (e.g. 'pnpm install needs network').",
    ),
});

const readShellOutputSchema = z.object({
  shellId: z
    .string()
    .describe("Shell id returned by runCommand(runInBackground=true)"),
});

const killShellSchema = z.object({
  shellId: z.string().describe("Shell id to terminate"),
});

const directoryStatsSchema = z.object({
  path: z.string().describe("Absolute path to directory"),
  maxEntries: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50_000)
    .describe("Hard cap on scanned entries to avoid huge recursive walks"),
});

const clearCacheSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Directory path to clear cache for (optional, clears all if not provided)",
    ),
});

// ---------------------------------------------------------------------------
// 工具工厂
// ---------------------------------------------------------------------------

function listDirectoryTool(
  scanner?: IncrementalScannerLike,
): ToolDefinition<z.infer<typeof listDirectorySchema>, unknown> {
  return {
    name: "listDirectory",
    description:
      "List files and directories at the given path with incremental scanning support",
    safety: "safe",
    inputSchema: listDirectorySchema,
    execute: async (args, ctx) => {
      const rel = await resolveRel(ctx.workspace, args.path);
      const useIncremental =
        (args.incremental ?? true) && scanner !== undefined;

      if (!useIncremental) {
        const entries = await ctx.workspace.fs.list(rel, { recursive: false });
        const sorted = sortEntries(entries);
        return args.includeStats
          ? {
              files: sorted,
              stats: { incremental: false, totalFiles: sorted.length },
            }
          : sorted;
      }

      const absDir = ctx.workspace.fs.resolve(rel);
      const scan = await scanner.scanIncremental(
        absDir,
        args.forceRescan ?? false,
      );
      const all = sortEntries([
        ...scan.added,
        ...scan.modified,
        ...scan.unchanged,
      ]);
      if (args.includeStats) {
        return {
          files: all,
          stats: {
            incremental: true,
            totalFiles: scan.totalFiles,
            added: scan.added.length,
            modified: scan.modified.length,
            deleted: scan.deleted.length,
            unchanged: scan.unchanged.length,
            scanTime: scan.scanTime,
            cache: scanner.getCacheStats(),
          },
        };
      }
      return all;
    },
  };
}

const readFileTool: ToolDefinition<{ path: string }, string> = {
  name: "readFile",
  description: "Read the text content of a file",
  safety: "safe",
  inputSchema: pathSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    const content = await ctx.workspace.fs.readFile(rel);
    const text = typeof content === "string" ? content : content.toString();
    return text.length > 50_000
      ? `${text.slice(0, 50_000)}\n...(truncated)`
      : text;
  },
};

const createDirectoryTool: ToolDefinition<{ path: string }, unknown> = {
  name: "createDirectory",
  description: "Create a directory (including parent directories)",
  safety: "destructive",
  inputSchema: pathSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    await ctx.workspace.fs.mkdir(rel, { recursive: true });
    return { success: true, path: args.path };
  },
};

const writeFileTool: ToolDefinition<
  z.infer<typeof writeFileSchema>,
  unknown
> = {
  name: "writeFile",
  description:
    "Write content to a file (creates or overwrites). Requires user approval. The new content goes ONLY in the `content` argument — after the call, report just the path and the returned diff stats (added/removed lines); do NOT repeat the file's contents in your chat reply.",
  safety: "destructive",
  inputSchema: writeFileSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    // 在覆盖*之前*先对前镜像计算 diff,使 turn 摘要能直接从结果读取权威的
    // +/- 行数,而不必在渲染端重新做 diff。尽力而为:预览失败绝不能
    // 阻塞实际写入。
    const diffStat = await computeWriteDiffStat(args, ctx).catch(() => null);
    await ctx.workspace.fs.writeFile(rel, args.content);
    return {
      success: true,
      path: args.path,
      ...(diffStat ? { diffStat } : {}),
    };
  },
};

/** `writeFile` 的前镜像 diff 统计,由共享预览推导得出。 */
async function computeWriteDiffStat(
  args: { path: string; content: string },
  ctx: ToolContext,
): Promise<{
  added: number;
  removed: number;
  isNew: boolean;
  isBinary: boolean;
  truncated: boolean;
}> {
  const preview = await computeWriteFilePreview(args, ctx.workspace);
  return {
    added: preview.added,
    removed: preview.removed,
    isNew: !preview.oldExists,
    isBinary: preview.isBinary,
    truncated: preview.truncated != null,
  };
}

const moveFileTool: ToolDefinition<z.infer<typeof moveFileSchema>, unknown> = {
  name: "moveFile",
  description: "Move or rename a file/directory. Requires user approval.",
  safety: "destructive",
  inputSchema: moveFileSchema,
  execute: async (args, ctx) => {
    const fromRel = await resolveRel(ctx.workspace, args.source);
    const toRel = await resolveRel(ctx.workspace, args.destination);
    await ctx.workspace.fs.rename(fromRel, toRel);
    return {
      success: true,
      source: args.source,
      destination: args.destination,
    };
  },
};

const deleteFileTool: ToolDefinition<{ path: string }, unknown> = {
  name: "deleteFile",
  description:
    "Delete a file or directory (recursive). Requires user approval. To empty a file without removing it, use `writeFile` with empty content.",
  safety: "destructive",
  inputSchema: pathSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    await ctx.workspace.fs.rm(rel, { recursive: true });
    return { success: true, path: args.path };
  },
};

/**
 * `runCommand` —— 宿主 shell 工具,做成工厂以便其 description 可携带
 * 可选的 git 工作流协议(HEREDOC 提交信息、`gh` / `glab` PR 模板)。
 * 调用方仅在活跃 workspace 由 git 支撑时才传入 `gitProtocol`;否则
 * description 保持精简,使非 git workspace 不必为不适用的规则付出
 * 注意力预算。
 *
 * 该协议刻意放在工具 description 中(而非系统提示)—— LLM 仅在考虑
 * 某个工具时才会以高权重把注意力分配给该工具的 description。这是
 * Claude Code 的 `Bash` 工具所采用的"按需"注入模式。
 */
const BACKGROUND_GUIDANCE = `Long-running commands (dev servers, watchers, REPLs) MUST use \`runInBackground: true\`. Foreground mode buffers stdout in memory and only returns when the child closes — for a dev server that never happens, so the agent hangs. Background mode returns a shellId immediately plus the first ~2s of output; use \`readShellOutput(shellId)\` to poll until you see the ready marker (e.g., \`Local: http://localhost:PORT\`), then \`killShell(shellId)\` when done.`;

/**
 * 为本次执行构造沙箱策略。escalatePermissions 经审批后 → 完全放开
 * (danger-full-access / passthrough);否则套用设置档位 + 当前 workspace
 * 的可写根。返回 undefined 表示不沙箱(无 config 的 eval/fork 路径)。
 */
async function buildRunPolicy(
  config: SandboxConfig | undefined,
  workspaceRoot: string,
  escalate: boolean,
): Promise<SandboxPolicy | undefined> {
  if (!config) return undefined;
  if (escalate) {
    return {
      mode: "danger-full-access",
      writableRoots: [],
      allowNetwork: true,
    };
  }
  return {
    mode: config.mode,
    allowNetwork: config.allowNetwork,
    writableRoots: await resolveWritableRoots(workspaceRoot),
  };
}

function runCommandTool(
  gitProtocol?: string,
  sandbox?: SandboxConfig,
): ToolDefinition<z.infer<typeof runCommandSchema>, unknown> {
  const parts = [
    "Execute a shell command in the workspace. Requires user approval.",
    BACKGROUND_GUIDANCE,
  ];
  if (gitProtocol) parts.push(gitProtocol);
  return {
    name: "runCommand",
    description: parts.join("\n\n"),
    safety: "destructive",
    inputSchema: runCommandSchema,
    execute: async (args, ctx) => {
      const cwdRel = args.cwd
        ? await resolveRel(ctx.workspace, args.cwd)
        : undefined;
      const policy = await buildRunPolicy(
        sandbox,
        ctx.workspace.root,
        args.escalatePermissions === true,
      );
      if (args.runInBackground) {
        const cwdAbs = cwdRel
          ? ctx.workspace.fs.resolve(cwdRel)
          : ctx.workspace.root;
        return spawnBackgroundShell(args.command, cwdAbs, {
          env: { BROWSER: process.env.BROWSER ?? "none" },
          sandbox: policy,
        });
      }
      const result = await ctx.workspace.exec.run(args.command, {
        cwd: cwdRel,
        signal: ctx.signal,
        sandbox: policy,
      });
      // 附上后端推导出的事实,使 turn 摘要(以及任何其他消费方)无需在
      // UI 中重新分类 / 重新解析 stdout。
      const commandKind = classifyCommand(args.command);
      const testStats =
        commandKind === "test"
          ? parseTestStats(result.stdout, result.stderr)
          : undefined;
      // 沙箱默认阻断出站网络;此时失败的 curl/wget/git/包管理器命令会以
      // 连接错误结束(curl 退出码 7)。告知模型真正的原因 + 修复办法,而不是
      // 任由它从一个孤零零的非零退出码去猜。
      const networkBlocked =
        policy != null &&
        isSandboxEffective(policy.mode) &&
        !policy.allowNetwork;
      const usesNetwork =
        /\b(curl|wget|git\s+(clone|fetch|pull|push)|npm|pnpm|yarn|bun|pip3?|brew)\b/.test(
          args.command,
        );
      const hint =
        networkBlocked &&
        usesNetwork &&
        typeof result.exitCode === "number" &&
        result.exitCode !== 0
          ? "Likely blocked by the sandbox's no-network policy (curl exit 7 = could not connect). To go online, retry the SAME command with escalatePermissions:true — it prompts for approval, then runs outside the sandbox."
          : undefined;
      return {
        ...result,
        // 非零退出码即工具失败:agent-loop 与 UI 都以 `success` 判定成败,
        // 而命令"跑完但退出非零"不抛异常,缺了这一行会停在绿色"完成"。
        success: result.exitCode === 0,
        commandKind,
        deliverable: isDeliverableCommand(args.command),
        ...(hint ? { hint } : {}),
        ...(testStats ? { testStats } : {}),
      };
    },
  };
}

const readShellOutputTool: ToolDefinition<
  z.infer<typeof readShellOutputSchema>,
  unknown
> = {
  name: "readShellOutput",
  description:
    "Read incremental stdout/stderr from a background shell. Returns only output produced since the previous call (per-stream offset is server-maintained). Use to poll a dev server until you see the ready marker like `Local: http://localhost:PORT`.",
  safety: "safe",
  inputSchema: readShellOutputSchema,
  execute: async (args) => {
    const result = readShell(args.shellId);
    if (!result) {
      return {
        shellId: args.shellId,
        error: "shell not found (already killed or never existed)",
      };
    }
    return result;
  },
};

const killShellTool: ToolDefinition<
  z.infer<typeof killShellSchema>,
  unknown
> = {
  name: "killShell",
  description:
    "Terminate a background shell. Sends SIGTERM then SIGKILL after 2 s. Idempotent — returns `found: false` if the shell was already cleaned up.",
  safety: "destructive",
  inputSchema: killShellSchema,
  execute: async (args) => killShellById(args.shellId),
};

const directoryStatsTool: ToolDefinition<
  z.infer<typeof directoryStatsSchema>,
  unknown
> = {
  name: "directoryStats",
  description:
    "Count files and total size by extension (each type returns { count, totalSize in bytes }) plus overall totals. Use this for any 'count / size by type' aggregation — never tally a listDirectory dump by hand.",
  safety: "safe",
  inputSchema: directoryStatsSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    const entries = await ctx.workspace.fs.list(rel, { recursive: true });
    let totalFiles = 0;
    let totalDirs = 0;
    let totalSize = 0;
    // 按扩展名分别统计数量与大小,使模型直接转述一张完成的表格,而不必
    // 按类型手动累加大小(它容易出错的那一步)。
    const extensions: Record<string, { count: number; totalSize: number }> = {};
    let scanned = 0;
    for (const entry of entries) {
      if (scanned >= args.maxEntries) break;
      scanned++;
      if (entry.isDirectory) {
        totalDirs++;
      } else {
        totalFiles++;
        totalSize += entry.size;
        const ext = entry.extension || "(no ext)";
        extensions[ext] ??= { count: 0, totalSize: 0 };
        const bucket = extensions[ext];
        bucket.count++;
        bucket.totalSize += entry.size;
      }
    }
    return {
      totalFiles,
      totalDirs,
      totalSize,
      extensions,
      scannedEntries: scanned,
      hitLimit: scanned >= args.maxEntries,
      maxEntries: args.maxEntries,
    };
  },
};

function getCacheStatsTool(
  scanner: IncrementalScannerLike,
): ToolDefinition<Record<string, never>, unknown> {
  return {
    name: "getCacheStats",
    description: "Get statistics about the incremental scanning cache",
    safety: "safe",
    inputSchema: z.object({}),
    execute: async () => {
      const stats = scanner.getCacheStats();
      return {
        directories: stats.directories,
        totalFiles: stats.totalFiles,
        memoryUsage: `${Math.round(stats.memoryUsage / 1024)} KB`,
        memoryUsageBytes: stats.memoryUsage,
      };
    },
  };
}

function clearDirectoryCacheTool(
  scanner: IncrementalScannerLike,
): ToolDefinition<z.infer<typeof clearCacheSchema>, unknown> {
  return {
    name: "clearDirectoryCache",
    description:
      "Clear incremental scanning cache for a directory or all directories",
    safety: "destructive",
    inputSchema: clearCacheSchema,
    execute: async (args, ctx) => {
      const absDir = args.path
        ? ctx.workspace.fs.resolve(await resolveRel(ctx.workspace, args.path))
        : undefined;
      await scanner.clearCache(absDir);
      return {
        success: true,
        message: args.path
          ? `Cache cleared for ${args.path}`
          : "All cache cleared",
        path: args.path,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 公开工厂
// ---------------------------------------------------------------------------

/**
 * 构建标准文件工具集合。传入 `incrementalScanner` 以启用增量列目录路径
 * 并注册缓存相关的辅助工具。
 */
export function buildFileTools(deps?: FileToolsDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    listDirectoryTool(deps?.incrementalScanner) as ToolDefinition,
    readFileTool as ToolDefinition,
    directoryStatsTool as ToolDefinition,
    createDirectoryTool as ToolDefinition,
    writeFileTool as ToolDefinition,
    moveFileTool as ToolDefinition,
    deleteFileTool as ToolDefinition,
    runCommandTool(deps?.gitProtocol, deps?.sandbox) as ToolDefinition,
    readShellOutputTool as ToolDefinition,
    killShellTool as ToolDefinition,
  ];
  if (deps?.incrementalScanner) {
    tools.push(getCacheStatsTool(deps.incrementalScanner) as ToolDefinition);
    tools.push(
      clearDirectoryCacheTool(deps.incrementalScanner) as ToolDefinition,
    );
  }
  return tools;
}

export type { ToolContext };
export {
  createDirectoryTool,
  deleteFileTool,
  directoryStatsTool,
  moveFileTool,
  readFileTool,
  runCommandTool,
  writeFileTool,
};
