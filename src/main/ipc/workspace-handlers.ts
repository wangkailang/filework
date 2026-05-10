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
      opts?: { kind?: "local" | "github"; metadata?: string | null },
    ) => {
      const kind = opts?.kind ?? "local";
      addRecentWorkspace(pathOrId, name, {
        kind,
        metadata: opts?.metadata ?? null,
      });

      // Project-skill discovery walks the filesystem, so it's only
      // meaningful for local workspaces. GitHub workspaces use the
      // clone dir but project-skill registration is a separate concern.
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
