/**
 * 用户附件文件的 IPC。
 *
 * `chat:attachFile` 接收渲染进程提供的源路径(来自原生文件选择器
 * 或拖放的 `webUtils.getPathForFile`),将文件拷贝到
 * `~/.filework/attachments/{sessionId}/`,从扩展名嗅探 MIME 与路由
 * 类型,并返回渲染进程构建 `AttachmentPart` 所需的元数据。
 *
 * 大小上限为 25 MB,以免误拖一个 4 GB 视频撑爆 JSONL 会话存储或模型
 * 上下文。超限时返回结构化的 `{ error }`(而非抛出异常),使渲染进程
 * 可以弹出提示。
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { ipcMain } from "electron";
import {
  type AttachmentKind,
  classifyKind,
  extFromMime,
  sniffMimeType,
} from "../../shared/mime";
import {
  saveAttachmentToDisk,
  saveBytesAttachmentToDisk,
} from "./media-storage";

// 重新导出,使现有的 handler 测试保持就近放置。规范实现位于
// shared/mime.ts。
export { classifyKind, extFromMime, sniffMimeType };

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export interface AttachFileResult {
  attachmentId: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export interface AttachFileError {
  error: string;
}

export const registerAttachmentHandlers = () => {
  ipcMain.handle(
    "chat:attachFile",
    async (
      _event,
      payload: {
        sessionId: string;
        sourcePath: string;
        originalName?: string;
      },
    ): Promise<AttachFileResult | AttachFileError> => {
      try {
        const st = await stat(payload.sourcePath);
        if (!st.isFile()) {
          return { error: "Not a regular file" };
        }
        if (st.size > MAX_BYTES) {
          return {
            error: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB > 25 MB)`,
          };
        }
        const name = payload.originalName || basename(payload.sourcePath);
        const mimeType = sniffMimeType(name);
        const kind = classifyKind(mimeType);
        const { path, shortId } = await saveAttachmentToDisk(
          payload.sourcePath,
          payload.sessionId,
        );
        return {
          attachmentId: shortId,
          path,
          name,
          mimeType,
          size: st.size,
          kind,
        };
      } catch (err) {
        console.error("[chat:attachFile]", err);
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /**
   * `chat:attachFile` 的剪贴板粘贴对应项。渲染进程从 `ClipboardItem`
   * 交来原始字节 + MIME;我们从 MIME 选取扩展名(剪贴板上不存在文件名)
   * 并写入同一个附件根目录,使后续流水线(`local-file://`、
   * AttachmentList、message-converter)无需关心文件从何而来。
   */
  ipcMain.handle(
    "chat:attachBlob",
    async (
      _event,
      payload: {
        sessionId: string;
        bytes: Uint8Array;
        mimeType: string;
        name?: string;
      },
    ): Promise<AttachFileResult | AttachFileError> => {
      try {
        // 本应用中渲染进程在技术上是受信任的,但 IPC 入口可从
        // preload 注入的 JS 触达 —— 因此显式校验 bytes 载荷,以免那里
        // 的 bug 用 `Cannot read property byteLength of undefined` 把
        // handler 弄崩。
        if (!ArrayBuffer.isView(payload.bytes)) {
          return { error: "Invalid payload: bytes must be a typed array" };
        }
        const size = payload.bytes.byteLength;
        if (size === 0) {
          return { error: "Empty file" };
        }
        if (size > MAX_BYTES) {
          return {
            error: `File too large (${(size / 1024 / 1024).toFixed(1)} MB > 25 MB)`,
          };
        }
        const ext = extFromMime(payload.mimeType);
        // basename() 会从渲染进程提供的显示名中剥离任何路径穿越 /
        // 目录字符。与 chat:attachFile 已通过 `basename(sourcePath)`
        // 做的净化处理一致。
        const safeName = payload.name
          ? basename(payload.name)
          : `pasted-${Date.now()}.${ext}`;
        const kind = classifyKind(payload.mimeType);
        const { path, shortId } = await saveBytesAttachmentToDisk(
          payload.bytes,
          payload.sessionId,
          ext,
        );
        return {
          attachmentId: shortId,
          path,
          name: safeName,
          mimeType: payload.mimeType,
          size,
          kind,
        };
      } catch (err) {
        console.error("[chat:attachBlob]", err);
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
};
