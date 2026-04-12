/**
 * Incremental File Scanner
 *
 * Provides efficient directory scanning by caching file metadata
 * and only scanning changed files on subsequent requests.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

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
 * Cache Manager for file system snapshots
 */
class CacheManager {
  private cachePath: string;
  private memoryCache = new Map<string, DirectorySnapshot>();

  constructor() {
    this.cachePath = join(homedir(), ".filework", "scan-cache.json");
  }

  /**
   * Load cache from disk and memory
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

      // Convert serialized cache back to in-memory format
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
      // Cache file doesn't exist or is corrupted, start fresh
      console.debug(
        "[IncrementalScanner] Cache not found or corrupted, starting fresh",
      );
    }
  }

  /**
   * Save cache to disk
   */
  async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });

      // Convert in-memory cache to serializable format
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
   * Get cached snapshot for directory
   */
  getSnapshot(dirPath: string): DirectorySnapshot | null {
    return this.memoryCache.get(dirPath) || null;
  }

  /**
   * Update cached snapshot for directory
   */
  updateSnapshot(dirPath: string, snapshot: DirectorySnapshot): void {
    this.memoryCache.set(dirPath, snapshot);
  }

  prune(policy: CachePolicy, now = Date.now()): void {
    // Remove expired snapshots first
    for (const [dirPath, snapshot] of this.memoryCache.entries()) {
      if (now - snapshot.lastScan.getTime() > policy.ttlMs) {
        this.memoryCache.delete(dirPath);
      }
    }

    // Then enforce size limits by evicting oldest snapshots
    const ordered = Array.from(this.memoryCache.entries()).sort(
      ([, a], [, b]) => a.lastScan.getTime() - b.lastScan.getTime(),
    );

    while (ordered.length > policy.maxDirectories) {
      const [oldestPath] = ordered.shift()!;
      this.memoryCache.delete(oldestPath);
    }

    let totalFiles = ordered.reduce(
      (sum, [, snapshot]) => sum + snapshot.files.size,
      0,
    );
    while (totalFiles > policy.maxTotalFiles && ordered.length > 0) {
      const [oldestPath, oldestSnapshot] = ordered.shift()!;
      this.memoryCache.delete(oldestPath);
      totalFiles -= oldestSnapshot.files.size;
    }
  }

  /**
   * Remove cached snapshot for directory
   */
  removeSnapshot(dirPath: string): void {
    this.memoryCache.delete(dirPath);
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.memoryCache.clear();
  }

  /**
   * Get cache statistics
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
 * Incremental Directory Scanner
 */
export class IncrementalScanner {
  private cacheManager: CacheManager;
  private initialized = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private policy: CachePolicy;

  // Files and directories to ignore
  private readonly IGNORE_PATTERNS = [
    /^\./, // hidden files
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
   * Initialize the scanner (load cache)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.cacheManager.loadCache();
    this.cacheManager.prune(this.policy);
    this.initialized = true;
  }

  /**
   * Queue cache persistence to avoid concurrent write races.
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
   * Check if file should be ignored
   */
  private shouldIgnore(name: string): boolean {
    return this.IGNORE_PATTERNS.some((pattern) => pattern.test(name));
  }

  /**
   * Scan directory and return all files
   */
  private async scanDirectory(
    dirPath: string,
  ): Promise<Map<string, FileMetadata>> {
    const files = new Map<string, FileMetadata>();

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue;

        const fullPath = join(dirPath, entry.name);

        try {
          const stats = await stat(fullPath);
          const fileMetadata: FileMetadata = {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            extension: entry.isDirectory() ? "" : extname(entry.name),
            mtime: stats.mtime,
            mtimeMs: stats.mtimeMs,
          };

          files.set(entry.name, fileMetadata);
        } catch {
          // Skip inaccessible files
        }
      }
    } catch (error) {
      console.error(
        `[IncrementalScanner] Failed to scan directory ${dirPath}:`,
        error,
      );
    }

    return files;
  }

  /**
   * Convert FileMetadata to FileEntry
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
   * Compare current files with cached snapshot
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
      // No cache, everything is new
      for (const file of currentFiles.values()) {
        added.push(this.toFileEntry(file));
      }
      return { added, modified, deleted, unchanged };
    }

    const cachedFiles = cachedSnapshot.files;

    // Check for added and modified files
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

    // Check for deleted files
    for (const [fileName, cachedFile] of cachedFiles.entries()) {
      if (!currentFiles.has(fileName)) {
        deleted.push(cachedFile.path);
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /**
   * Perform incremental scan of directory
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

    // Note: Removed unsafe directory mtime optimization that could miss file changes
    // Modifying existing files doesn't update parent directory mtime, leading to stale results

    // Perform actual directory scan
    const currentFiles = await this.scanDirectory(dirPath);
    const changes = this.compareWithCache(currentFiles, cachedSnapshot);

    // Update cache
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

    // Save cache to disk (asynchronously, serialized)
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
   * Force full rescan of directory
   */
  async scanFull(dirPath: string): Promise<FileEntry[]> {
    const result = await this.scanIncremental(dirPath, true);
    return [...result.added, ...result.modified, ...result.unchanged];
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cacheManager.getCacheStats();
  }

  /**
   * Clear cache for specific directory or all
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
   * Flush pending cache writes. Primarily used by tests.
   */
  async flushPendingWrites(): Promise<void> {
    await this.saveQueue;
  }
}

// Global instance for reuse across requests
let globalScanner: IncrementalScanner | null = null;

/**
 * Get or create global scanner instance
 */
export function getIncrementalScanner(): IncrementalScanner {
  if (!globalScanner) {
    globalScanner = new IncrementalScanner();
  }
  return globalScanner;
}
