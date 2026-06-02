/**
 * 预览分发器 —— 根据工具名挑选对应的生成器,且永不抛出异常。
 * approval-batcher 在 `flushBuffer` 期间调用本函数,在 IPC 事件到达
 * 渲染进程之前,为每条待审批条目附加结构化的变更预览。
 *
 * PR2 仅接入 `writeFile`;PR4 将新增 move/delete/mkdir/run。
 * 未知或失败的工具返回 `undefined`,渲染进程回退到仅展示描述的行。
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

/** 单个生成器运行时长的硬上限。调用方仍应将其与自身的外层超时进行竞速。 */
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
