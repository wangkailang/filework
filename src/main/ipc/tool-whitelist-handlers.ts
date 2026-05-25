import { ipcMain } from "electron";
import { dangerousToolNames } from "./ai-tools";
import {
  listPersistentToolWhitelist,
  setPersistentToolWhitelist,
} from "./tool-whitelist";

// 危险工具白名单的管理用 IPC——供设置面板读取/切换「始终允许」状态。
export const registerToolWhitelistHandlers = () => {
  // 返回可管理的危险工具全集 + 当前已加入白名单的工具。
  ipcMain.handle("tool-whitelist:getState", async () => {
    return {
      tools: dangerousToolNames,
      enabled: listPersistentToolWhitelist(),
    };
  });

  // 切换某工具的白名单状态。
  ipcMain.handle(
    "tool-whitelist:set",
    async (_event, payload: { toolName: string; enabled: boolean }) => {
      setPersistentToolWhitelist(payload.toolName, payload.enabled);
      return { ok: true };
    },
  );
};
