import { createRequire } from "node:module";

/** native 重复文件查找器返回的单个文件条目。 */
export interface NativeFileEntry {
  path: string;
  size: number;
}

/** native 重复文件扫描的聚合结果。 */
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

// createRequire 在两种环境下都可用:
// - 打包后的 Electron 主进程(由 electron-vite 打包为 CommonJS,
//   主进程支持 import.meta.url),以及
// - vitest(以 ESM 运行,原生提供 import.meta.url)。
// 在 vitest 的 ESM 下,顶层裸 require(...) 会抛出 "require is not defined",
// 因此不能直接使用它。
const requireNative = createRequire(import.meta.url);

let native: NativeModule | undefined;

// 延迟加载并记忆化:该 addon 是硬依赖(无 JS 兜底),
// 但在首次使用时加载而非在导入时加载,可避免缺失或无法构建的
// addon 导致应用启动崩溃 —— 只有在真正调用时,重复文件查找
// 功能才会失败,并给出可操作的提示信息。
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

/** 用 native (Rust) 实现扫描目录中的重复文件。 */
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
