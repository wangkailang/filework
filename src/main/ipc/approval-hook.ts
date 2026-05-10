/**
 * Build the `beforeToolCall` hook that AgentLoop uses to gate destructive
 * tools through the existing approval IPC flow.
 *
 * Replaces the per-tool wrapping that lived in the deleted
 * `ai-tool-permissions.ts:buildTools` (removed in M2 PR 4 after the
 * AgentLoop migration completed for both main and fork-mode paths).
 *
 * Approval logic precedence:
 *   1. writeFile + plan-approved task + path inside workspace → auto-approve
 *   2. tool already user-approved this task (whitelist) → auto-approve (inside requestApproval)
 *   3. moveFile/deleteFile/runCommand: workspace bounds check (deny if outside)
 *   4. Otherwise: send ai:stream-tool-approval, await user response
 */

import type { WebContents } from "electron";

import type { BeforeToolCallHook } from "../core/agent/tool-registry";
import { requestApproval } from "./ai-tools";
import { canAutoApproveWrite, isInWorkspace } from "./approval-utils";

interface BuildApprovalHookOptions {
  sender: WebContents;
  taskId: string;
}

const DENIED_REASON = "用户拒绝了此操作";
const OUTSIDE_WORKSPACE_REASON = "路径必须在当前 workspace 内";

export const buildApprovalHook = ({
  sender,
  taskId,
}: BuildApprovalHookOptions): BeforeToolCallHook => {
  return async (call, ctx) => {
    // ── Plan-approved writeFile fast path ───────────────────────────
    if (call.toolName === "writeFile") {
      const args = call.args as { path?: string };
      if (args.path && (await canAutoApproveWrite(taskId, args.path))) {
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

    // ── M8: pre-PR CI heads-up (best-effort, never blocks) ──────────
    let extraContext: string | undefined;
    if (call.toolName === "openPullRequest" && ctx.workspace.scm?.listCIRuns) {
      try {
        const branch = await ctx.workspace.scm.currentBranch?.();
        if (branch) {
          const runs = await ctx.workspace.scm.listCIRuns({
            ref: branch,
            limit: 1,
          });
          const latest = runs[0];
          if (
            latest &&
            (latest.conclusion === "failure" ||
              latest.conclusion === "cancelled")
          ) {
            extraContext = `⚠️ 最近的 CI 运行 (${latest.name}) 状态为 ${latest.conclusion}。继续打开 PR/MR 之前请确认。\n${latest.url}`;
          }
        }
      } catch {
        // Best-effort: a CI lookup failure (rate limit, no Actions, expired
        // token) must never block the user from opening a PR.
      }
    }

    // ── User approval (whitelist short-circuit lives inside) ────────
    const approved = await requestApproval(
      sender,
      taskId,
      call.toolCallId,
      call.toolName,
      call.args,
      ctx.signal,
      extraContext,
    );
    return approved ? { allow: true } : { allow: false, reason: DENIED_REASON };
  };
};
