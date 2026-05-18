import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { ipcMain } from "electron";

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

// Stable error tags the renderer detects via error.message prefix.
// IPC flattens Error → string, so prefix is the only reliable channel.
export const FS_ERROR_TAG = {
  PERMISSION_DENIED: "FS_PERMISSION_DENIED",
  NOT_FOUND: "FS_NOT_FOUND",
} as const;

const isPermissionError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === "EPERM" || code === "EACCES";
};

const isNotFoundError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: string }).code === "ENOENT";
};

const wrapFsError = (err: unknown, path: string): Error => {
  if (isPermissionError(err)) {
    return new Error(`[${FS_ERROR_TAG.PERMISSION_DENIED}] ${path}`);
  }
  if (isNotFoundError(err)) {
    return new Error(`[${FS_ERROR_TAG.NOT_FOUND}] ${path}`);
  }
  return err instanceof Error ? err : new Error(String(err));
};

export const registerFileHandlers = () => {
  // List directory contents
  ipcMain.handle(
    "fs:listDirectory",
    async (_event, dirPath: string, _depth = 1): Promise<FileInfo[]> => {
      const entries = await readdir(dirPath, { withFileTypes: true }).catch(
        (err: unknown) => {
          throw wrapFsError(err, dirPath);
        },
      );
      const files: FileInfo[] = [];

      for (const entry of entries) {
        // Skip hidden files and common ignore patterns
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;

        const fullPath = join(dirPath, entry.name);
        try {
          const stats = await stat(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            extension: entry.isDirectory() ? "" : extname(entry.name),
            modifiedAt: stats.mtime.toISOString(),
          });
        } catch {
          // Skip files we can't stat (permission issues, etc.)
        }
      }

      return files.sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },
  );

  // Read file content
  ipcMain.handle("fs:readFile", async (_event, filePath: string) => {
    const content = await readFile(filePath, "utf-8");
    return content;
  });

  // Read file as base64 (for binary files like PDF)
  ipcMain.handle("fs:readFileBase64", async (_event, filePath: string) => {
    const buffer = await readFile(filePath);
    return buffer.toString("base64");
  });

  // Get directory stats
  ipcMain.handle("fs:directoryStats", async (_event, dirPath: string) => {
    const entries = await readdir(dirPath, {
      withFileTypes: true,
      recursive: true,
    }).catch((err: unknown) => {
      throw wrapFsError(err, dirPath);
    });
    let totalFiles = 0;
    let totalDirs = 0;
    let totalSize = 0;
    const extensions: Record<string, number> = {};

    for (const entry of entries) {
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
          const stats = await stat(fullPath);
          totalSize += stats.size;
          const ext = extname(entry.name) || "(no ext)";
          extensions[ext] = (extensions[ext] || 0) + 1;
        }
      } catch {
        // Skip inaccessible entries
      }
    }

    return { totalFiles, totalDirs, totalSize, extensions };
  });
};
