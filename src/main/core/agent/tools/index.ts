/**
 * Built-in file tools, ToolRegistry-shaped.
 *
 * These are the M1 replacements for `safeTools` / `rawExecutors` in
 * `src/main/ipc/ai-tools.ts`. They route every filesystem and exec call
 * through `ctx.workspace.*`, so the same tool body works for any
 * `Workspace` implementation (LocalWorkspace today, GitHub/GitLab later).
 *
 * Tool inputSchemas continue to accept absolute paths (the model has been
 * trained on this in prompts and skill bodies) — `resolveRel()` converts
 * them to workspace-relative form, which means out-of-sandbox absolute
 * paths surface as a `WorkspaceEscapeError` from `toRelative()` rather
 * than being silently joined.
 */

import path from "node:path";
import { z } from "zod/v4";

import type { Workspace } from "../../workspace/types";
import type { ToolContext, ToolDefinition } from "../tool-registry";

// ---------------------------------------------------------------------------
// Optional deps for incremental scanning (wired in PR 2)
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
}

// ---------------------------------------------------------------------------
// Helpers
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
// Schemas
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
    .describe("Working directory (defaults to workspace root)"),
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
// Tool factories
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
    "Write content to a file (creates or overwrites). Requires user approval.",
  safety: "destructive",
  inputSchema: writeFileSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    await ctx.workspace.fs.writeFile(rel, args.content);
    return { success: true, path: args.path };
  },
};

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
  description: "Delete a file or directory. Requires user approval.",
  safety: "destructive",
  inputSchema: pathSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    await ctx.workspace.fs.rm(rel, { recursive: true });
    return { success: true, path: args.path };
  },
};

const runCommandTool: ToolDefinition<
  z.infer<typeof runCommandSchema>,
  unknown
> = {
  name: "runCommand",
  description:
    "Execute a shell command in the workspace. Requires user approval.",
  safety: "destructive",
  inputSchema: runCommandSchema,
  execute: async (args, ctx) => {
    const cwdRel = args.cwd
      ? await resolveRel(ctx.workspace, args.cwd)
      : undefined;
    return ctx.workspace.exec.run(args.command, {
      cwd: cwdRel,
      signal: ctx.signal,
    });
  },
};

const directoryStatsTool: ToolDefinition<
  z.infer<typeof directoryStatsSchema>,
  unknown
> = {
  name: "directoryStats",
  description:
    "Get statistics about a directory (file count, size, extensions)",
  safety: "safe",
  inputSchema: directoryStatsSchema,
  execute: async (args, ctx) => {
    const rel = await resolveRel(ctx.workspace, args.path);
    const entries = await ctx.workspace.fs.list(rel, { recursive: true });
    let totalFiles = 0;
    let totalDirs = 0;
    let totalSize = 0;
    const extensions: Record<string, number> = {};
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
        extensions[ext] = (extensions[ext] || 0) + 1;
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
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build the standard set of file tools. Pass an `incrementalScanner` to
 * enable the incremental listing path and register the cache utility tools.
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
    runCommandTool as ToolDefinition,
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
