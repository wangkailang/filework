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
  clearUserMemory,
  clearWorkspaceMemory,
  forgetMemory,
  getWorkspaceMemoryInfo,
  type MemoryCategory,
  type MemoryScope,
  rememberMemory,
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

  // 清空 user 作用域记忆(跨工作区的个人偏好,与具体工作目录无关)。
  ipcMain.handle(
    "workspace-memory:clear-user",
    async (): Promise<{ ok: boolean }> => {
      await clearUserMemory();
      return { ok: true };
    },
  );

  // 删除单条记忆(面板逐条删除)。
  ipcMain.handle(
    "workspace-memory:forget",
    async (
      _event,
      payload: { workspacePath?: string; scope: MemoryScope; key: string },
    ): Promise<{ ok: boolean }> => {
      if (!payload?.workspacePath) return { ok: false };
      await forgetMemory(
        new LocalWorkspace(payload.workspacePath),
        payload.scope,
        payload.key,
      );
      return { ok: true };
    },
  );

  // 更新单条记忆的文本(面板就地编辑,沿用原 key/scope/category)。
  ipcMain.handle(
    "workspace-memory:update",
    async (
      _event,
      payload: {
        workspacePath?: string;
        scope: MemoryScope;
        key: string;
        category: MemoryCategory;
        text: string;
      },
    ): Promise<{ ok: boolean }> => {
      if (!payload?.workspacePath || !payload.text.trim()) return { ok: false };
      try {
        await rememberMemory(new LocalWorkspace(payload.workspacePath), {
          key: payload.key,
          scope: payload.scope,
          category: payload.category,
          text: payload.text,
        });
      } catch {
        // 命中敏感信息护栏(MemorySecretError)等 → 不写入,返回失败。
        return { ok: false };
      }
      return { ok: true };
    },
  );
};
