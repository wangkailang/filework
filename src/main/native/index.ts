import { createRequire } from "node:module";

/** Single file entry returned by the native duplicate finder. */
export interface NativeFileEntry {
  path: string;
  size: number;
}

/** Aggregated result of a native duplicate scan. */
export interface NativeDuplicateResult {
  scanned: number;
  skipped: number;
  duplicateGroups: number;
  totalWastedBytes: number;
  groups: NativeFileEntry[][];
}

/** native 目录统计的聚合结果。 */
export interface NativeDirectoryStats {
  totalFiles: number;
  totalDirs: number;
  totalSize: number;
  /** 扩展名直方图，区分大小写;无扩展名记为 "(no ext)"。 */
  extensions: Record<string, number>;
}

/** native 单层目录扫描返回的一个条目元数据。 */
export interface NativeDirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  /** 修改时间(毫秒),跟随符号链接;用于增量扫描的变更比对。 */
  mtimeMs: number;
}

interface NativeModule {
  findDuplicates(
    rootPath: string,
    extensions?: string[] | null,
  ): Promise<NativeDuplicateResult>;
  directoryStats(rootPath: string): Promise<NativeDirectoryStats>;
  scanDirectoryLevel(dirPath: string): Promise<NativeDirEntry[]>;
}

// createRequire works in BOTH environments:
// - packaged Electron main process (bundled to CommonJS by electron-vite,
//   which supports import.meta.url in the main process), and
// - vitest (runs as ESM and provides import.meta.url natively).
// A bare top-level require(...) would throw "require is not defined" under
// vitest's ESM, so we must not use it.
const requireNative = createRequire(import.meta.url);

let native: NativeModule | undefined;

// Load lazily and memoize: the addon is a hard dependency (no JS fallback),
// but loading it on first use rather than at import time keeps a missing or
// unbuildable addon from crashing app startup — only the duplicate-finder
// feature fails, with an actionable message, when it is actually invoked.
function loadNative(): NativeModule {
  if (native) return native;
  try {
    native = requireNative("@filework/native") as NativeModule;
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load @filework/native — run 'pnpm install' to rebuild (requires Rust toolchain). Original error: ${original}`,
    );
  }
  return native;
}

/** Scan a directory for duplicate files using the native (Rust) implementation. */
export function findDuplicates(
  rootPath: string,
  extensions?: string[],
): Promise<NativeDuplicateResult> {
  return loadNative().findDuplicates(rootPath, extensions);
}

/** 用 native (Rust) 实现递归统计目录的文件/目录数、总大小与扩展名分布。 */
export function directoryStats(
  rootPath: string,
): Promise<NativeDirectoryStats> {
  return loadNative().directoryStats(rootPath);
}

/**
 * 用 native (Rust) 单层(非递归)扫描目录,并行 stat 每个条目。
 * 不做 ignore 过滤,过滤与元数据加工由调用方负责。
 */
export function scanDirectoryLevel(dirPath: string): Promise<NativeDirEntry[]> {
  return loadNative().scanDirectoryLevel(dirPath);
}
