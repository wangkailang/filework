/**
 * Incremental File Scanner
 *
 * Provides efficient directory scanning by caching file metadata
 * and only scanning changed files on subsequent requests.
 */

import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";

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
  directories: Record<string, {
    path: string;
    lastScan: string;
    files: Record<string, Omit<FileMetadata, 'mtime'> & { mtime: string }>;
    subdirectories: string[];
  }>;
  lastUpdate: string;
  version: number;
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
    this.cachePath = join(homedir(), '.filework', 'scan-cache.json');
  }

  /**
   * Load cache from disk and memory
   */
  async loadCache(): Promise<void> {
    try {
      const data = await readFile(this.cachePath, 'utf-8');
      const cache: ScanCache = JSON.parse(data);

      // Convert serialized cache back to in-memory format
      for (const [dirPath, snapshot] of Object.entries(cache.directories)) {
        const files = new Map<string, FileMetadata>();

        for (const [fileName, fileData] of Object.entries(snapshot.files)) {
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
    } catch (error) {
      // Cache file doesn't exist or is corrupted, start fresh
      console.debug('[IncrementalScanner] Cache not found or corrupted, starting fresh');
    }
  }

  /**
   * Save cache to disk
   */
  async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });

      // Convert in-memory cache to serializable format
      const serializableDirectories: ScanCache['directories'] = {};

      for (const [dirPath, snapshot] of this.memoryCache.entries()) {
        const files: Record<string, Omit<FileMetadata, 'mtime'> & { mtime: string }> = {};

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
        version: 1,
      };

      await writeFile(this.cachePath, JSON.stringify(cache, null, 2));
    } catch (error) {
      console.error('[IncrementalScanner] Failed to save cache:', error);
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
  getCacheStats(): { directories: number; totalFiles: number; memoryUsage: number } {
    let totalFiles = 0;
    for (const snapshot of this.memoryCache.values()) {
      totalFiles += snapshot.files.size;
    }

    return {
      directories: this.memoryCache.size,
      totalFiles,
      memoryUsage: JSON.stringify(Array.from(this.memoryCache.entries())).length,
    };
  }
}

/**
 * Incremental Directory Scanner
 */
export class IncrementalScanner {
  private cacheManager: CacheManager;
  private initialized = false;

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

  constructor() {
    this.cacheManager = new CacheManager();
  }

  /**
   * Initialize the scanner (load cache)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.cacheManager.loadCache();
    this.initialized = true;
  }

  /**
   * Check if file should be ignored
   */
  private shouldIgnore(name: string): boolean {
    return this.IGNORE_PATTERNS.some(pattern => pattern.test(name));
  }

  /**
   * Scan directory and return all files
   */
  private async scanDirectory(dirPath: string): Promise<Map<string, FileMetadata>> {
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
      console.error(`[IncrementalScanner] Failed to scan directory ${dirPath}:`, error);
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
    cachedSnapshot: DirectorySnapshot | null
  ): { added: FileEntry[]; modified: FileEntry[]; deleted: string[]; unchanged: FileEntry[] } {
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
  async scanIncremental(dirPath: string, forceRescan = false): Promise<IncrementalScanResult> {
    const startTime = Date.now();

    await this.initialize();

    const cachedSnapshot = forceRescan ? null : this.cacheManager.getSnapshot(dirPath);

    // Quick check: if directory mtime hasn't changed, return cached results
    if (cachedSnapshot && !forceRescan) {
      try {
        const dirStats = await stat(dirPath);
        if (dirStats.mtime <= cachedSnapshot.lastScan) {
          const unchanged = Array.from(cachedSnapshot.files.values()).map(file =>
            this.toFileEntry(file)
          );

          return {
            added: [],
            modified: [],
            deleted: [],
            unchanged,
            totalFiles: unchanged.length,
            scanTime: Date.now() - startTime,
          };
        }
      } catch {
        // Directory doesn't exist or is inaccessible
      }
    }

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
          .filter(file => file.isDirectory)
          .map(file => file.name)
      ),
    };

    this.cacheManager.updateSnapshot(dirPath, newSnapshot);

    // Save cache to disk (asynchronously)
    this.cacheManager.saveCache().catch(error => {
      console.error('[IncrementalScanner] Failed to save cache:', error);
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
    await this.cacheManager.saveCache();
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