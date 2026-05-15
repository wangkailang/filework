/**
 * IPC: local-git:* — branch operations for local (non-clone) workspaces.
 *
 * Mirrors the `github:*` / `gitlab:*` branch surface: probe (current),
 * listBranches, checkoutBranch. The clone-cache `checkoutBranchTo`
 * helper does the actual switch — same dirty-tree refusal as remote.
 */
import { ipcMain } from "electron";

import { checkoutBranchTo, runGit } from "../core/workspace/clone-cache";
import { startHeadWatcher } from "../core/workspace/head-watcher";
import { listLocalBranches, probeLocalGit } from "../core/workspace/local-git";

export const registerLocalGitHandlers = () => {
  ipcMain.handle(
    "local-git:probe",
    async (_event, payload: { path: string }) => {
      const probe = await probeLocalGit(payload.path);
      // Probe doubles as "renderer is opening this workspace" — start
      // the HEAD watcher so chat-driven `git checkout` syncs the chip.
      // No-op for non-git dirs (watcher returns early on missing HEAD).
      if (probe.isGitRepo) void startHeadWatcher(payload.path);
      return probe;
    },
  );

  ipcMain.handle(
    "local-git:listBranches",
    async (_event, payload: { path: string }) => {
      return listLocalBranches(payload.path);
    },
  );

  ipcMain.handle(
    "local-git:checkoutBranch",
    async (_event, payload: { path: string; branch: string }) => {
      const before = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: payload.path,
      });
      const previousBranch = before.exitCode === 0 ? before.stdout.trim() : "";
      await checkoutBranchTo(payload.path, payload.branch);
      return { branch: payload.branch, previousBranch };
    },
  );
};
