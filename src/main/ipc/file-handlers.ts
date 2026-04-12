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

export const registerFileHandlers = () => {
  // List directory contents
  ipcMain.handle(
    "fs:listDirectory",
    async (_event, dirPath: string, _depth = 1): Promise<FileInfo[]> => {
      const entries = await readdir(dirPath, { withFileTypes: true });
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
