/**
 * 增量文件扫描器
 *
 * 通过缓存文件元数据来高效扫描目录,后续请求只扫描发生变化的文件。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { type NativeDirEntry, scanDirectoryLevel } from "../native";

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

interface FileMetadata {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  mtime: Date;
  mtimeMs: number;
}

interface DirectorySnapshot {
  path: string;
  lastScan: Date;
  files: Map<string, FileMetadata>;
  subdirectories: Set<string>;
}

interface ScanCache {
  directories: Record<
    string,
    {
      path: string;
      lastScan: string;
      files: Record<string, Omit<FileMetadata, "mtime"> & { mtime: string }>;
      subdirectories: string[];
    }
  >;
  lastUpdate: string;
  version: number;
}

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DIRECTORIES = 200;
const DEFAULT_MAX_TOTAL_FILES = 200_000;

export interface CachePolicy {
  ttlMs: number;
  maxDirectories: number;
  maxTotalFiles: number;
}

export interface IncrementalScanResult {
  added: FileEntry[];
  modified: FileEntry[];
  deleted: string[];
  unchanged: FileEntry[];
  totalFiles: number;
  scanTime: number;
}

/**
 * 文件系统快照的缓存管理器
 */
class CacheManager {
  private cachePath: string;
  private memoryCache = new Map<string, DirectorySnapshot>();

  constructor() {
    this.cachePath = join(homedir(), ".filework", "scan-cache.json");
  }

  /**
   * 从磁盘和内存加载缓存
   */
  async loadCache(): Promise<void> {
    try {
      const data = await readFile(this.cachePath, "utf-8");
      const cache: ScanCache = JSON.parse(data);
      if (
        cache.version !== CACHE_VERSION ||
        Number.isNaN(Date.parse(cache.lastUpdate)) ||
        !cache.directories ||
        typeof cache.directories !== "object"
      ) {
        throw new Error("Invalid cache metadata");
      }

      // 将序列化的缓存还原为内存格式
      for (const [dirPath, snapshot] of Object.entries(cache.directories)) {
        if (Number.isNaN(Date.parse(snapshot.lastScan))) {
          continue;
        }
        const files = new Map<string, FileMetadata>();

        for (const [fileName, fileData] of Object.entries(snapshot.files)) {
          if (Number.isNaN(Date.parse(fileData.mtime))) {
            continue;
          }
          files.set(fileName, {
            ...fileData,
            mtime: new Date(fileData.mtime),
          });
        }

        this.memoryCache.set(dirPath, {
          path: snapshot.path,
          lastScan: new Date(snapshot.lastScan),
          files,
          subdirectories: new Set(snapshot.subdirectories),
        });
      }
    } catch (_error) {
      // 缓存文件不存在或已损坏,重新开始
      console.debug(
        "[IncrementalScanner] Cache not found or corrupted, starting fresh",
      );
    }
  }

  /**
   * 将缓存保存到磁盘
   */
  async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });

      // 将内存缓存转换为可序列化格式
      const serializableDirectories: ScanCache["directories"] = {};

      for (const [dirPath, snapshot] of this.memoryCache.entries()) {
        const files: Record<
          string,
          Omit<FileMetadata, "mtime"> & { mtime: string }
        > = {};

        for (const [fileName, fileData] of snapshot.files.entries()) {
          files[fileName] = {
            ...fileData,
            mtime: fileData.mtime.toISOString(),
          };
        }

        serializableDirectories[dirPath] = {
          path: snapshot.path,
          lastScan: snapshot.lastScan.toISOString(),
          files,
          subdirectories: Array.from(snapshot.subdirectories),
        };
      }

      const cache: ScanCache = {
        directories: serializableDirectories,
        lastUpdate: new Date().toISOString(),
        version: CACHE_VERSION,
      };

      await writeFile(this.cachePath, JSON.stringify(cache, null, 2));
    } catch (error) {
      console.error("[IncrementalScanner] Failed to save cache:", error);
    }
  }

  /**
   * 获取目录的缓存快照
   */
  getSnapshot(dirPath: string): DirectorySnapshot | null {
    return this.memoryCache.get(dirPath) || null;
  }

  /**
   * 更新目录的缓存快照
   */
  updateSnapshot(dirPath: string, snapshot: DirectorySnapshot): void {
    this.memoryCache.set(dirPath, snapshot);
  }

  prune(policy: CachePolicy, now = Date.now()): void {
    // 先移除过期的快照
    for (const [dirPath, snapshot] of this.memoryCache.entries()) {
      if (now - snapshot.lastScan.getTime() > policy.ttlMs) {
        this.memoryCache.delete(dirPath);
      }
    }

    // 然后通过淘汰最旧的快照来强制满足容量上限
    const ordered = Array.from(this.memoryCache.entries()).sort(
      ([, a], [, b]) => a.lastScan.getTime() - b.lastScan.getTime(),
    );

    while (ordered.length > policy.maxDirectories) {
      const oldest = ordered.shift();
      if (!oldest) break;
      const [oldestPath] = oldest;
      this.memoryCache.delete(oldestPath);
    }

    let totalFiles = ordered.reduce(
      (sum, [, snapshot]) => sum + snapshot.files.size,
      0,
    );
    while (totalFiles > policy.maxTotalFiles && ordered.length > 0) {
      const oldest = ordered.shift();
      if (!oldest) break;
      const [oldestPath, oldestSnapshot] = oldest;
      this.memoryCache.delete(oldestPath);
      totalFiles -= oldestSnapshot.files.size;
    }
  }

  /**
   * 移除目录的缓存快照
   */
  removeSnapshot(dirPath: string): void {
    this.memoryCache.delete(dirPath);
  }

  /**
   * 清空所有缓存
   */
  clearCache(): void {
    this.memoryCache.clear();
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): {
    directories: number;
    totalFiles: number;
    memoryUsage: number;
  } {
    let totalFiles = 0;
    for (const snapshot of this.memoryCache.values()) {
      totalFiles += snapshot.files.size;
    }

    return {
      directories: this.memoryCache.size,
      totalFiles,
      memoryUsage: JSON.stringify(Array.from(this.memoryCache.entries()))
        .length,
    };
  }
}

/**
 * 增量目录扫描器
 */
export class IncrementalScanner {
  private cacheManager: CacheManager;
  private initialized = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private policy: CachePolicy;

  // 需要忽略的文件和目录
  private readonly IGNORE_PATTERNS = [
    /^\./, // 隐藏文件
    /^node_modules$/,
    /^\.git$/,
    /^\.DS_Store$/,
    /^thumbs\.db$/i,
    /\.tmp$/,
    /^\.cache$/,
    /^dist$/,
    /^build$/,
    /^coverage$/,
  ];

  constructor(policy: Partial<CachePolicy> = {}) {
    this.cacheManager = new CacheManager();
    this.policy = {
      ttlMs: policy.ttlMs ?? DEFAULT_TTL_MS,
      maxDirectories: policy.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
      maxTotalFiles: policy.maxTotalFiles ?? DEFAULT_MAX_TOTAL_FILES,
    };
  }

  /**
   * 初始化扫描器(加载缓存)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.cacheManager.loadCache();
    this.cacheManager.prune(this.policy);
    this.initialized = true;
  }

  /**
   * 将缓存持久化排队,避免并发写竞争。
   */
  private queueCacheSave(): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await this.cacheManager.saveCache();
      });
    return this.saveQueue;
  }

  /**
   * 检查文件是否应被忽略
   */
  private shouldIgnore(name: string): boolean {
    return this.IGNORE_PATTERNS.some((pattern) => pattern.test(name));
  }

  /**
   * 单层扫描目录并返回所有文件。
   *
   * 下沉到 native (Rust):readdir + 并行 stat 在 native 完成,过滤
   * (shouldIgnore)、扩展名计算、路径拼接与 mtime 转换仍留在此处,
   * 以保持与旧实现完全一致的行为。
   */
  private async scanDirectory(
    dirPath: string,
  ): Promise<Map<string, FileMetadata>> {
    const files = new Map<string, FileMetadata>();

    let entries: NativeDirEntry[];
    try {
      entries = await scanDirectoryLevel(dirPath);
    } catch (error) {
      console.error(
        `[IncrementalScanner] Failed to scan directory ${dirPath}:`,
        error,
      );
      return files;
    }

    for (const entry of entries) {
      if (this.shouldIgnore(entry.name)) continue;

      files.set(entry.name, {
        name: entry.name,
        path: join(dirPath, entry.name),
        isDirectory: entry.isDirectory,
        size: entry.size,
        extension: entry.isDirectory ? "" : extname(entry.name),
        mtime: new Date(entry.mtimeMs),
        mtimeMs: entry.mtimeMs,
      });
    }

    return files;
  }

  /**
   * 将 FileMetadata 转换为 FileEntry
   */
  private toFileEntry(metadata: FileMetadata): FileEntry {
    return {
      name: metadata.name,
      path: metadata.path,
      isDirectory: metadata.isDirectory,
      size: metadata.size,
      extension: metadata.extension,
      modifiedAt: metadata.mtime.toISOString(),
    };
  }

  /**
   * 将当前文件与缓存快照进行比较
   */
  private compareWithCache(
    currentFiles: Map<string, FileMetadata>,
    cachedSnapshot: DirectorySnapshot | null,
  ): {
    added: FileEntry[];
    modified: FileEntry[];
    deleted: string[];
    unchanged: FileEntry[];
  } {
    const added: FileEntry[] = [];
    const modified: FileEntry[] = [];
    const unchanged: FileEntry[] = [];
    const deleted: string[] = [];

    if (!cachedSnapshot) {
      // 无缓存,全部视为新增
      for (const file of currentFiles.values()) {
        added.push(this.toFileEntry(file));
      }
      return { added, modified, deleted, unchanged };
    }

    const cachedFiles = cachedSnapshot.files;

    // 检测新增和修改的文件
    for (const [fileName, currentFile] of currentFiles.entries()) {
      const cachedFile = cachedFiles.get(fileName);

      if (!cachedFile) {
        added.push(this.toFileEntry(currentFile));
      } else if (
        cachedFile.mtimeMs !== currentFile.mtimeMs ||
        cachedFile.size !== currentFile.size
      ) {
        modified.push(this.toFileEntry(currentFile));
      } else {
        unchanged.push(this.toFileEntry(currentFile));
      }
    }

    // 检测已删除的文件
    for (const [fileName, cachedFile] of cachedFiles.entries()) {
      if (!currentFiles.has(fileName)) {
        deleted.push(cachedFile.path);
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /**
   * 对目录执行增量扫描
   */
  async scanIncremental(
    dirPath: string,
    forceRescan = false,
  ): Promise<IncrementalScanResult> {
    const startTime = Date.now();

    await this.initialize();

    let cachedSnapshot = forceRescan
      ? null
      : this.cacheManager.getSnapshot(dirPath);
    if (
      cachedSnapshot &&
      Date.now() - cachedSnapshot.lastScan.getTime() > this.policy.ttlMs
    ) {
      this.cacheManager.removeSnapshot(dirPath);
      cachedSnapshot = null;
    }

    // 注意:已移除可能漏检文件变更的不安全目录 mtime 优化
    // 修改已有文件不会更新父目录的 mtime,会导致结果过时

    // 执行实际的目录扫描
    const currentFiles = await this.scanDirectory(dirPath);
    const changes = this.compareWithCache(currentFiles, cachedSnapshot);

    // 更新缓存
    const newSnapshot: DirectorySnapshot = {
      path: dirPath,
      lastScan: new Date(),
      files: currentFiles,
      subdirectories: new Set(
        Array.from(currentFiles.values())
          .filter((file) => file.isDirectory)
          .map((file) => file.name),
      ),
    };

    this.cacheManager.updateSnapshot(dirPath, newSnapshot);
    this.cacheManager.prune(this.policy);

    // 将缓存保存到磁盘(异步、串行化)
    this.queueCacheSave().catch((error) => {
      console.error("[IncrementalScanner] Failed to save cache:", error);
    });

    return {
      ...changes,
      totalFiles: currentFiles.size,
      scanTime: Date.now() - startTime,
    };
  }

  /**
   * 强制对目录进行全量重新扫描
   */
  async scanFull(dirPath: string): Promise<FileEntry[]> {
    const result = await this.scanIncremental(dirPath, true);
    return [...result.added, ...result.modified, ...result.unchanged];
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats() {
    return this.cacheManager.getCacheStats();
  }

  /**
   * 清除指定目录或全部目录的缓存
   */
  async clearCache(dirPath?: string): Promise<void> {
    if (dirPath) {
      this.cacheManager.removeSnapshot(dirPath);
    } else {
      this.cacheManager.clearCache();
    }
    await this.queueCacheSave();
  }

  /**
   * 刷写挂起的缓存写入。主要供测试使用。
   */
  async flushPendingWrites(): Promise<void> {
    await this.saveQueue;
  }
}

// 跨请求复用的全局实例
let globalScanner: IncrementalScanner | null = null;

/**
 * 获取或创建全局扫描器实例
 */
export function getIncrementalScanner(): IncrementalScanner {
  if (!globalScanner) {
    globalScanner = new IncrementalScanner();
  }
  return globalScanner;
}
