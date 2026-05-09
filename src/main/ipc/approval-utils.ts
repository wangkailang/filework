/**
 * Shared approval / sandbox helpers used by both the legacy per-tool
 * approval wrappers in `ai-tool-permissions.ts` (fork-mode skill path)
 * and the new `beforeToolCall` hook driving AgentLoop.
 *
 * Logic is unchanged from the pre-M2 inline copies in `ai-tool-permissions.ts:27-128`;
 * extraction lets both paths share a single source of truth.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

import { getPlanApprovedWorkspace, getTaskWorkspace } from "./ai-task-control";

/**
 * Verify that all `paths` resolve inside the task's workspace, after
 * symlink resolution. Used to gate destructive tools (move, delete, etc.).
 *
 * Returns false if no workspace is registered, on any realpath failure,
 * or if any target escapes the workspace boundary.
 */
export const isInWorkspace = async (
  taskId: string,
  paths: string[],
): Promise<boolean> => {
  const workspace =
    getTaskWorkspace(taskId) ?? getPlanApprovedWorkspace(taskId);
  if (!workspace) return false;
  try {
    const realWorkspace = await realpath(workspace);
    for (const p of paths) {
      let realTarget: string;
      try {
        realTarget = await realpath(p);
      } catch {
        const parentDir = path.dirname(path.resolve(p));
        const parentReal = await realpath(parentDir);
        realTarget = path.join(parentReal, path.basename(p));
      }
      if (
        !(
          realTarget === realWorkspace ||
          realTarget.startsWith(realWorkspace + path.sep)
        )
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * Auto-approval predicate for writeFile in plan-approved tasks.
 * Resolves symlinks via realpath to prevent workspace-escape writes.
 * For new files, validates the parent directory.
 */
export const canAutoApproveWrite = async (
  taskId: string,
  filePath: string,
): Promise<boolean> => {
  const workspace = getPlanApprovedWorkspace(taskId);
  if (!workspace) return false;

  try {
    const realWorkspace = await realpath(workspace);

    let realTarget: string;
    try {
      realTarget = await realpath(filePath);
    } catch {
      const parentDir = path.dirname(path.resolve(filePath));
      try {
        realTarget = path.join(
          await realpath(parentDir),
          path.basename(filePath),
        );
      } catch {
        return false;
      }
    }

    return (
      realTarget.startsWith(realWorkspace + path.sep) ||
      realTarget === realWorkspace
    );
  } catch {
    return false;
  }
};
