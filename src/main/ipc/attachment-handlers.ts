/**
 * User-attached file IPC.
 *
 * `chat:attachFile` takes a renderer-supplied source path (from the
 * native file picker or a drag-drop `webUtils.getPathForFile`), copies
 * the file into `~/.filework/attachments/{sessionId}/`, sniffs MIME and
 * routing kind from the extension, and returns the metadata the
 * renderer needs to build an `AttachmentPart`.
 *
 * Size-capped at 25 MB so a stray drag of a 4 GB video can't blow up
 * the JSONL session store or the model context. The cap returns a
 * structured `{ error }` (not a thrown exception) so the renderer can
 * surface a toast.
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

// Re-exported so the existing handler tests stay co-located. The
// canonical implementation lives in shared/mime.ts.
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
   * Clipboard-paste counterpart to `chat:attachFile`. Renderer hands over
   * the raw bytes + MIME from a `ClipboardItem`; we pick the extension
   * from the MIME (no filename exists on the clipboard) and write under
   * the same attachments root so the rest of the pipeline (`local-file://`,
   * AttachmentList, message-converter) doesn't care how the file got there.
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
        // Renderer is technically trusted in this app, but the IPC
        // surface is reachable from preload-injected JS — validate the
        // bytes payload explicitly so a bug there can't crash the
        // handler with `Cannot read property byteLength of undefined`.
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
        // basename() strips any traversal / directory chars from a
        // renderer-supplied display name. Matches the laundering
        // chat:attachFile already does via `basename(sourcePath)`.
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
