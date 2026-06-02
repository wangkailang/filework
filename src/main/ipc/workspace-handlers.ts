import { ipcMain } from "electron";
import {
  addRecentWorkspace,
  getRecentWorkspaces,
  removeRecentWorkspace,
} from "../db";
import { skillRegistry } from "../skills";

export const registerWorkspaceHandlers = () => {
  ipcMain.handle("workspace:getRecent", async () => {
    return getRecentWorkspaces();
  });

  ipcMain.handle(
    "workspace:addRecent",
    async (
      _event,
      pathOrId: string,
      name: string,
      opts?: {
        kind?: "local" | "github" | "gitlab";
        metadata?: string | null;
      },
    ) => {
      const kind = opts?.kind ?? "local";
      addRecentWorkspace(pathOrId, name, {
        kind,
        metadata: opts?.metadata ?? null,
      });

      // 项目技能发现会遍历文件系统,因此仅对本地工作目录有意义。
      // GitHub 工作目录使用克隆目录,但项目技能注册是另一回事。
      if (kind === "local") {
        try {
          await skillRegistry.refreshProjectSkills(pathOrId);
          console.log(`[workspace] Refreshed project skills for: ${pathOrId}`);
        } catch (err) {
          console.warn("[workspace] Failed to refresh project skills:", err);
        }
      }

      return true;
    },
  );

  ipcMain.handle("workspace:removeRecent", async (_event, path: string) => {
    removeRecentWorkspace(path);
    return true;
  });
};
