/**
 * Build the `beforeToolCall` hook that AgentLoop uses to gate destructive
 * tools through the existing approval IPC flow.
 *
 * Approval logic precedence:
 *   1. writeFile + plan-approved task + path inside workspace → auto-approve
 *   2. tool already user-approved this task (whitelist) → auto-approve (inside requestApproval)
 *   3. moveFile/deleteFile/runCommand: workspace bounds check (deny if outside)
 *   4. Otherwise: enqueue into the batched approval card (ai:stream-tool-batch-approval)
 *      via requestApproval → approval-batcher, await user decision.
 */

import type { WebContents } from "electron";
import { dispatchPreview, PREVIEW_TIMEOUT_MS } from "../core/agent/preview";
import { rememberPreview } from "../core/agent/preview/snapshot-store";
import type { BeforeToolCallHook } from "../core/agent/tool-registry";
import type { Workspace } from "../core/workspace/types";
import { requestApproval } from "./ai-tools";
import { canAutoApproveWrite, isInWorkspace } from "./approval-utils";

interface BuildApprovalHookOptions {
  sender: WebContents;
  taskId: string;
  /**
   * Workspace that owns this task. Threaded into the approval batcher
   * so it can read pre-image files and produce a structured change
   * preview for the approval card. Optional for backward compat —
   * absent workspaces fall back to a description-only card.
   */
  workspace?: Workspace;
}

const DENIED_REASON = "用户拒绝了此操作";
const OUTSIDE_WORKSPACE_REASON = "路径必须在当前 workspace 内";

export const buildApprovalHook = ({
  sender,
  taskId,
  workspace,
}: BuildApprovalHookOptions): BeforeToolCallHook => {
  return async (call) => {
    // ── Plan-approved writeFile fast path ───────────────────────────
    if (call.toolName === "writeFile") {
      const args = call.args as { path?: string };
      if (args.path && (await canAutoApproveWrite(taskId, args.path))) {
        // Plan-approved writes skip the batcher (and therefore the
        // batch-level preview generation). Run it once here so the
        // post-execute tool card still shows the diff straight from a
        // snapshot, matching the manual approval path.
        if (workspace) {
          try {
            const preview = await Promise.race([
              dispatchPreview(call.toolName, call.args, workspace),
              new Promise<undefined>((res) => {
                setTimeout(() => res(undefined), PREVIEW_TIMEOUT_MS);
              }),
            ]);
            if (preview) rememberPreview(call.toolCallId, preview);
          } catch {
            // Preview is best-effort.
          }
        }
        if (!sender.isDestroyed()) {
          sender.send("ai:tool-auto-approved", {
            id: taskId,
            toolCallId: call.toolCallId,
            toolName: "writeFile",
            path: args.path,
          });
        }
        return { allow: true };
      }
    }

    // ── Workspace-bounds check (preserves pre-M2 deny reason) ───────
    // Surface a friendly Chinese reason instead of letting the raw
    // WorkspaceEscapeError from inside the tool body bubble up.
    if (call.toolName === "moveFile") {
      const args = call.args as { source?: string; destination?: string };
      const targets = [args.source, args.destination].filter(
        (p): p is string => typeof p === "string",
      );
      if (targets.length === 2 && !(await isInWorkspace(taskId, targets))) {
        return { allow: false, reason: OUTSIDE_WORKSPACE_REASON };
      }
    }
    if (call.toolName === "deleteFile") {
      const args = call.args as { path?: string };
      if (args.path && !(await isInWorkspace(taskId, [args.path]))) {
        return { allow: false, reason: OUTSIDE_WORKSPACE_REASON };
      }
    }
    if (call.toolName === "runCommand") {
      const args = call.args as { cwd?: string };
      if (args.cwd && !(await isInWorkspace(taskId, [args.cwd]))) {
        return { allow: false, reason: "cwd 必须在当前 workspace 内" };
      }
    }

    // ── User approval (whitelist short-circuit lives inside) ────────
    const approved = await requestApproval(
      sender,
      taskId,
      call.toolCallId,
      call.toolName,
      call.args,
      undefined,
      workspace,
    );
    return approved ? { allow: true } : { allow: false, reason: DENIED_REASON };
  };
};
