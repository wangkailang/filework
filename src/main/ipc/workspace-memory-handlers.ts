/**
 * 工作目录记忆的查看 / 清空 IPC。
 *
 * 给渲染层的「Workspace Memory」设置面板用:读取当前工作目录的记忆信息
 * (人写指令 + 机器记忆 + 合并结果),以及清空机器记忆。
 * 写入由 Agent 的 `updateMemory` 工具负责,这里不提供写接口。
 */

import { ipcMain } from "electron";

import { LocalWorkspace } from "../core/workspace/local-workspace";
import {
  clearWorkspaceMemory,
  getWorkspaceMemoryInfo,
  type WorkspaceMemoryInfo,
} from "../core/workspace/workspace-memory";

export const registerWorkspaceMemoryHandlers = (): void => {
  ipcMain.handle(
    "workspace-memory:get",
    async (
      _event,
      payload: { workspacePath?: string },
    ): Promise<WorkspaceMemoryInfo | null> => {
      if (!payload?.workspacePath) return null;
      return getWorkspaceMemoryInfo(new LocalWorkspace(payload.workspacePath));
    },
  );

  ipcMain.handle(
    "workspace-memory:clear",
    async (
      _event,
      payload: { workspacePath?: string },
    ): Promise<{ ok: boolean }> => {
      if (!payload?.workspacePath) return { ok: false };
      await clearWorkspaceMemory(new LocalWorkspace(payload.workspacePath));
      return { ok: true };
    },
  );
};
