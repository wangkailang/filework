/**
 * 共享的审批 / 沙箱辅助函数,由 `ai-tool-permissions.ts` 中的遗留
 * 逐工具审批包装器(fork 模式 skill 路径)与驱动 AgentLoop 的新
 * `beforeToolCall` 钩子共同使用。
 *
 * 逻辑与 `ai-tool-permissions.ts:27-128` 中 M2 之前的内联副本一致;
 * 抽取出来使两条路径共享同一份事实来源。
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

import { getPlanApprovedWorkspace, getTaskWorkspace } from "./ai-task-control";

/**
 * 校验所有 `paths` 在符号链接解析后均落在任务的 workspace 内。
 * 用于门控破坏性工具(move、delete 等)。
 *
 * 若未注册 workspace、任一 realpath 失败,或任一目标越过 workspace
 * 边界,则返回 false。
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
 * 计划已审批任务中 writeFile 的自动批准判定。
 * 通过 realpath 解析符号链接以防止越出 workspace 的写入。
 * 对于新文件,校验其父目录。
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
