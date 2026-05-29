import { open, readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { ipcMain } from "electron";
import { directoryStats } from "../native";

// 文件预览的读取上限:超过则只读前 N 字节并标记 truncated,
// 避免把几百 MB 的文件整体读入内存、序列化过 IPC 拖垮渲染进程。
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024; // 10 MB

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

  // 文件预览专用读取:对超大文件做截断,避免整体读入内存 / 过 IPC。
  // 返回 { content, truncated, totalBytes };truncated 时 content 仅为前 MAX_PREVIEW_BYTES。
  ipcMain.handle("fs:readFilePreview", async (_event, filePath: string) => {
    try {
      const { size } = await stat(filePath);
      if (size <= MAX_PREVIEW_BYTES) {
        const content = await readFile(filePath, "utf-8");
        return { content, truncated: false, totalBytes: size };
      }
      // 超限:只读前 MAX_PREVIEW_BYTES 字节。
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_PREVIEW_BYTES);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          MAX_PREVIEW_BYTES,
          0,
        );
        let content = buffer.subarray(0, bytesRead).toString("utf-8");
        // 截到最后一个完整换行:避免半行,顺带丢掉因字节边界产生的半个多字节字符。
        const lastNewline = content.lastIndexOf("\n");
        if (lastNewline > 0) {
          content = content.slice(0, lastNewline);
        }
        return { content, truncated: true, totalBytes: size };
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw wrapFsError(err, filePath);
    }
  });

  // 获取目录统计:下沉到 native (Rust) 实现,复刻原 TS 的过滤与计数语义,
  // 返回结构保持不变 { totalFiles, totalDirs, totalSize, extensions }。
  ipcMain.handle("fs:directoryStats", (_event, dirPath: string) =>
    directoryStats(dirPath),
  );
};
