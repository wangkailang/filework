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
  sniffMimeType,
} from "../../shared/mime";
import { saveAttachmentToDisk } from "./media-storage";

// Re-exported so the existing handler tests stay co-located. The
// canonical implementation lives in shared/mime.ts.
export { classifyKind, sniffMimeType };

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
};
