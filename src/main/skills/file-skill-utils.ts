import { stat, access } from "node:fs/promises";
import { extname } from "node:path";

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  size?: number;
}

/**
 * 校验文件：存在性、扩展名、大小限制
 */
export const validateFile = async (
  filePath: string,
  allowedExtensions: string[],
): Promise<FileValidationResult> => {
  try {
    await access(filePath);
  } catch {
    return { valid: false, error: `文件不存在: ${filePath}` };
  }

  const ext = extname(filePath).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `不支持的文件格式: ${ext}，支持的格式: ${allowedExtensions.join(", ")}`,
    };
  }

  const stats = await stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，最大支持 50MB`,
    };
  }

  return { valid: true, size: stats.size };
};
