/**
 * 生成媒体的磁盘布局与下载辅助方法(共享)。
 *
 * 第二阶段图像和第三阶段视频在下载上游提供方返回的短时效 CDN URL 后,
 * 都会把文件写入 `~/.filework/generated/{sessionId}/{timestamp}-{shortId}.{ext}`。
 * 两个调用方此前各自重复同样的逻辑,且都内置了一份私有的 `tsSlug()`——
 * 在此统一收敛,使新增一种媒体形态只需一次 import。
 */

import crypto from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const GENERATED_ROOT = join(homedir(), ".filework", "generated");
const ATTACHMENTS_ROOT = join(homedir(), ".filework", "attachments");

/** 导出供协议处理器做路径校验使用。 */
export const generatedRoot = (): string => GENERATED_ROOT;

/** 导出供协议处理器做路径校验使用。 */
export const attachmentsRoot = (): string => ATTACHMENTS_ROOT;

/** 文件系统安全的 ISO 时间戳:`YYYYMMDDTHHMMSSZ`。 */
export const tsSlug = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export interface SavedMedia {
  /** 写入的绝对路径。 */
  path: string;
  /** 与时间戳配对的 8 位随机十六进制串;可安全用作 React key。 */
  shortId: string;
}

const decodeDataUrl = (url: string): Uint8Array | null => {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(url);
  if (!match) return null;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  return isBase64
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"));
};

const writeGeneratedMedia = async (
  bytes: Uint8Array,
  sessionId: string,
  ext: string,
): Promise<SavedMedia> => {
  const shortId = crypto.randomBytes(4).toString("hex");
  const dir = join(GENERATED_ROOT, sessionId || "default");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tsSlug()}-${shortId}.${ext}`);
  await writeFile(path, bytes);
  return { path, shortId };
};

/**
 * 下载一个媒体 URL 并持久化到
 * `~/.filework/generated/{sessionId}/{ts}-{shortId}.{ext}`。
 *
 * 遇到 HTTP 错误时抛出,以便调用方通过 IPC 错误通道上报。使用注入的 fetch,
 * 从而让分流代理规则得以生效。
 */
export const saveMediaToDisk = async (
  fetchFn: typeof fetch,
  url: string,
  sessionId: string,
  ext: string,
): Promise<SavedMedia> => {
  const dataBytes = decodeDataUrl(url);
  if (dataBytes) {
    return writeGeneratedMedia(dataBytes, sessionId, ext);
  }

  const resp = await fetchFn(url);
  if (!resp.ok) {
    throw new Error(`download HTTP ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return writeGeneratedMedia(bytes, sessionId, ext);
};

export interface SavedAttachment {
  /** 写入到 `~/.filework/attachments/{sessionId}/` 下的绝对路径。 */
  path: string;
  /** 8 位十六进制串;同时用作 React key。 */
  shortId: string;
}

/**
 * 将用户选择 / 拖入的文件复制到
 * `~/.filework/attachments/{sessionId}/{ts}-{shortId}.{ext}`。
 *
 * 使用 `fs.copyFile` 而非读取→写入,从而避免数兆字节的 PDF 被载入内存。
 * 保留源文件扩展名,使渲染进程的 `local-file://` 协议处理器能根据后缀推断 MIME。
 */
export const saveAttachmentToDisk = async (
  sourcePath: string,
  sessionId: string,
): Promise<SavedAttachment> => {
  const ext = extname(sourcePath).replace(/^\./, "").toLowerCase() || "bin";
  const shortId = crypto.randomBytes(4).toString("hex");
  const dir = join(ATTACHMENTS_ROOT, sessionId || "default");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tsSlug()}-${shortId}.${ext}`);
  await copyFile(sourcePath, path);
  return { path, shortId };
};

/**
 * 将渲染进程提供的字节缓冲(剪贴板粘贴、内存中的 blob)写入与
 * `saveAttachmentToDisk` 相同的附件目录。由调用方指定扩展名,使磁盘上的文件
 * 与渲染进程已分类好的 MIME 保持一致——从而让 `local-file://` 的 MIME 嗅探保持一致。
 */
export const saveBytesAttachmentToDisk = async (
  bytes: Uint8Array,
  sessionId: string,
  ext: string,
): Promise<SavedAttachment> => {
  // 纵深防御:尽管当前唯一的调用方(`chat:attachBlob`)的 ext 来自
  // extFromMime 的 11 项白名单 + "bin",仍剥离所有非字母数字字符并限制长度,
  // 防止未来的调用方借 ext 做路径穿越或生成非法文件名("png?v=1"、"../evil" 等)。
  const cleanExt =
    ext
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 10) || "bin";
  const shortId = crypto.randomBytes(4).toString("hex");
  const dir = join(ATTACHMENTS_ROOT, sessionId || "default");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tsSlug()}-${shortId}.${cleanExt}`);
  await writeFile(path, bytes);
  return { path, shortId };
};
