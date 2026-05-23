/**
 * Preview dispatcher — picks the right generator for the tool name and
 * never throws. Approval-batcher fires this during `flushBuffer` to
 * decorate each pending approval entry with a structured change preview
 * before the IPC event reaches the renderer.
 *
 * PR2 wires only `writeFile`; PR4 will add move/delete/mkdir/run.
 * Unknown or failing tools return `undefined`, and the renderer falls
 * back to its description-only row.
 */

import type { Workspace } from "../../workspace/types";
import { computeCreateDirectoryPreview } from "./create-directory";
import { computeDeleteFilePreview } from "./delete-file";
import { computeMoveFilePreview } from "./move-file";
import { computeRunCommandPreview } from "./run-command";
import type { ToolPreview } from "./types";
import { computeWriteFilePreview } from "./write-file";

export { computeCreateDirectoryPreview } from "./create-directory";
export { computeDeleteFilePreview } from "./delete-file";
export { computeMoveFilePreview } from "./move-file";
export { computeRunCommandPreview } from "./run-command";
export type { ToolPreview } from "./types";
export { computeWriteFilePreview } from "./write-file";

/** Hard cap on a single generator's runtime. Callers should still
 *  race this against their own outer timeout. */
export const PREVIEW_TIMEOUT_MS = 2_000;

export async function dispatchPreview(
  toolName: string,
  args: unknown,
  workspace: Workspace,
): Promise<ToolPreview | undefined> {
  try {
    switch (toolName) {
      case "writeFile": {
        const a = args as { path?: unknown; content?: unknown };
        if (typeof a.path !== "string" || typeof a.content !== "string") {
          return undefined;
        }
        return await computeWriteFilePreview(
          { path: a.path, content: a.content },
          workspace,
        );
      }
      case "moveFile": {
        const a = args as { source?: unknown; destination?: unknown };
        if (typeof a.source !== "string" || typeof a.destination !== "string") {
          return undefined;
        }
        return await computeMoveFilePreview(
          { source: a.source, destination: a.destination },
          workspace,
        );
      }
      case "deleteFile": {
        const a = args as { path?: unknown };
        if (typeof a.path !== "string") return undefined;
        return await computeDeleteFilePreview({ path: a.path }, workspace);
      }
      case "createDirectory": {
        const a = args as { path?: unknown };
        if (typeof a.path !== "string") return undefined;
        return await computeCreateDirectoryPreview({ path: a.path }, workspace);
      }
      case "runCommand": {
        const a = args as { command?: unknown; cwd?: unknown };
        if (typeof a.command !== "string") return undefined;
        return await computeRunCommandPreview(
          {
            command: a.command,
            cwd: typeof a.cwd === "string" ? a.cwd : undefined,
          },
          workspace,
        );
      }
      default:
        return undefined;
    }
  } catch (err) {
    console.warn(
      `[preview] generator threw for tool "${toolName}":`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
