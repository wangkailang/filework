/**
 * 构建 AgentLoop 使用的 `beforeToolCall` 钩子,通过现有审批 IPC 流程对
 * 破坏性工具进行门控。
 *
 * 审批逻辑优先级:
 *   1. writeFile + 计划已审批任务 + 路径在 workspace 内 → 自动批准
 *   2. 工具在本任务已被用户批准(白名单)→ 自动批准(在 requestApproval 内部)
 *   3. moveFile/deleteFile/runCommand/runProcess:workspace 边界检查(越界则拒绝)
 *   4. 否则:通过 requestApproval → approval-batcher 入队到批量审批卡片
 *      (ai:stream-tool-batch-approval),等待用户决策。
 */

import path from "node:path";
import type { WebContents } from "electron";
import { isBrowserToolName } from "../browser/browser-policy";
import { dispatchPreview, PREVIEW_TIMEOUT_MS } from "../core/agent/preview";
import { rememberPreview } from "../core/agent/preview/snapshot-store";
import type { BeforeToolCallHook } from "../core/agent/tool-registry";
import {
  isSandboxEffective,
  resolveApprovalPolicy,
  resolveSandboxConfig,
} from "../core/sandbox";
import type { ApprovalPolicy, SandboxMode } from "../core/sandbox/types";
import type { Workspace } from "../core/workspace/types";
import { getSetting } from "../db";
import { requestApproval } from "./ai-tools";
import { canAutoApproveWrite, isInWorkspace } from "./approval-utils";

interface BuildApprovalHookOptions {
  sender: WebContents;
  taskId: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  /**
   * 拥有此任务的 workspace。传入审批批处理器,使其能读取变更前的
   * 文件并为审批卡片生成结构化的变更预览。为向后兼容而设为可选 ——
   * 缺失 workspace 时回落为仅描述的卡片。
   */
  workspace?: Workspace;
}

const DENIED_REASON = "用户拒绝了此操作";
const OUTSIDE_WORKSPACE_REASON = "路径必须在当前 workspace 内";

const isPathInProvidedWorkspace = async (
  workspace: Workspace | undefined,
  candidate: string,
): Promise<boolean> => {
  if (!workspace) return false;
  const abs = path.isAbsolute(candidate)
    ? candidate
    : workspace.fs.resolve(candidate);
  try {
    await workspace.fs.toRelative(abs);
    return true;
  } catch {
    return false;
  }
};

/** db 未初始化(如单测)时回落 null,使设置解析走默认值。 */
const safeGetSetting = (key: string): string | null => {
  try {
    return getSetting(key);
  } catch {
    return null;
  }
};

export const buildApprovalHook = ({
  approvalPolicy: approvalPolicyOverride,
  sandboxMode: sandboxModeOverride,
  sender,
  taskId,
  workspace,
}: BuildApprovalHookOptions): BeforeToolCallHook => {
  return async (call) => {
    // Browser calls are independently gated by origin and element risk in
    // beforeAnyToolCall; do not show a second generic approval card.
    if (isBrowserToolName(call.toolName)) return { allow: true };
    const approvalPolicy =
      approvalPolicyOverride ??
      resolveApprovalPolicy(safeGetSetting("approvalPolicy"));
    const sandboxConfig = sandboxModeOverride
      ? resolveSandboxConfig(sandboxModeOverride)
      : resolveSandboxConfig(safeGetSetting("sandboxMode"));
    const isFullAccess =
      approvalPolicy === "never" && sandboxConfig.mode === "danger-full-access";

    // ── 计划已审批的 writeFile 快速路径 ───────────────────────────
    if (call.toolName === "writeFile") {
      const args = call.args as { path?: string };
      if (args.path && (await canAutoApproveWrite(taskId, args.path))) {
        // 计划已审批的写入会跳过批处理器(因而也跳过批级别的预览
        // 生成)。在此处运行一次,使执行后的工具卡片仍能直接从快照
        // 展示 diff,与手动审批路径保持一致。
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
            // 预览为尽力而为。
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

    // ── workspace 边界检查(保留 M2 之前的拒绝原因)───────
    // 给出友好的中文原因,而不是让工具体内部的原始
    // WorkspaceEscapeError 冒泡上来。
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
    if (call.toolName === "runCommand" || call.toolName === "runProcess") {
      const args = call.args as { cwd?: string; escalatePermissions?: boolean };
      const escalate = args.escalatePermissions === true;

      // cwd 越界:未提权时直接拒;提权时交由审批弹窗判断。
      if (
        !isFullAccess &&
        !escalate &&
        args.cwd &&
        !(
          (await isPathInProvidedWorkspace(workspace, args.cwd)) ||
          (await isInWorkspace(taskId, [args.cwd]))
        )
      ) {
        return { allow: false, reason: "cwd 必须在当前 workspace 内" };
      }

      if (approvalPolicy === "never") {
        if (escalate && sandboxConfig.mode !== "danger-full-access") {
          return {
            allow: false,
            reason: "当前 Chat 权限不是完全访问权限，不能自动批准提权命令。",
          };
        }
        return { allow: true };
      }

      // 两层模型:提权一律弹窗;否则按审批策略 + 沙箱是否生效决定。
      // 沙箱真正生效(darwin 非 danger 档)时,内核兜底,可免弹窗;
      // 沙箱无效(如非 macOS)则即便策略宽松也必须弹窗兜底。
      if (!escalate) {
        if (
          approvalPolicy !== "untrusted" &&
          isSandboxEffective(sandboxConfig.mode)
        ) {
          return { allow: true };
        }
      }
      // escalate 或需弹窗 → 落到下方 requestApproval。
    }

    if (approvalPolicy === "never") {
      return { allow: true };
    }

    // ── 用户审批(白名单短路逻辑在其内部)────────
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
