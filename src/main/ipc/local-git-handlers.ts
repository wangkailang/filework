/**
 * IPC: local-git:* — 针对本地(非克隆)工作区的分支操作。
 *
 * 与 `github:*` / `gitlab:*` 的分支接口保持一致:probe(当前分支)、
 * listBranches、checkoutBranch。实际的分支切换由 clone-cache 的
 * `checkoutBranchTo` 辅助函数完成 —— 与远程一样,工作区不干净时拒绝切换。
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
      // probe 同时也意味着「渲染进程正在打开此工作区」—— 启动
      // HEAD watcher,使聊天驱动的 `git checkout` 能同步分支标签。
      // 对非 git 目录为空操作(HEAD 缺失时 watcher 会提前返回)。
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
