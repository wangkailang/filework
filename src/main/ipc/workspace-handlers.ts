import { ipcMain } from "electron";
import { addRecentWorkspace, getRecentWorkspaces, removeRecentWorkspace } from "../db";
import { skillRegistry } from "../skills";

export const registerWorkspaceHandlers = () => {
  ipcMain.handle("workspace:getRecent", async () => {
    return getRecentWorkspaces();
  });

  ipcMain.handle("workspace:addRecent", async (_event, path: string, name: string) => {
    addRecentWorkspace(path, name);

    // Refresh project-level skills when the workspace changes
    try {
      await skillRegistry.refreshProjectSkills(path);
      console.log(`[workspace] Refreshed project skills for: ${path}`);
    } catch (err) {
      console.warn("[workspace] Failed to refresh project skills:", err);
    }

    return true;
  });

  ipcMain.handle("workspace:removeRecent", async (_event, path: string) => {
    removeRecentWorkspace(path);
    return true;
  });
};
