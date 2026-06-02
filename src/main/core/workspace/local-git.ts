/**
 * local-git — *本地*(非克隆)工作区的 git 操作。
 *
 * github/gitlab 工作区类负责克隆新鲜度、认证和远程跟踪语义;
 * 本地工作区没有这些。本模块暴露渲染进程显示分支标签所需的两个操作:
 *
 *   - `probeLocalGit` —— 该目录是否是 git 仓库?若是,HEAD 是什么?
 *   - `listLocalBranches` —— 仅本地 refs/heads/*(不含远程跟踪)。
 *
 * 分支切换复用 `clone-cache.ts` 的 `checkoutBranchTo` ——
 * 相同的脏工作树拒绝策略、相同的锁语义。
 *
 * 游离 HEAD 报告为 `currentBranch: null`,这样渲染进程可以隐藏分支标签,
 * 而不是渲染一个具有误导性的「分支」名称。
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { runGit } from "./clone-cache";

export interface LocalGitProbe {
  isGitRepo: boolean;
  /** 分支名,游离 HEAD / 非 git 目录时为 null。 */
  currentBranch: string | null;
}

export interface LocalBranchSummary {
  name: string;
  /** 本地始终为 false —— 保护是托管服务方的概念。 */
  protected: boolean;
}

const isGitDir = async (absPath: string): Promise<boolean> => {
  try {
    const st = await stat(path.join(absPath, ".git"));
    // `.git` 在普通仓库中是目录,在 worktree 中是文件。
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
};

export const probeLocalGit = async (
  absPath: string,
  spawnFn: typeof spawn = spawn,
): Promise<LocalGitProbe> => {
  if (!(await isGitDir(absPath))) {
    return { isGitRepo: false, currentBranch: null };
  }
  const res = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: absPath,
    spawnFn,
  });
  if (res.exitCode !== 0) {
    return { isGitRepo: true, currentBranch: null };
  }
  const branch = res.stdout.trim();
  // `rev-parse --abbrev-ref HEAD` 在游离状态下会打印字面量 "HEAD" ——
  // 将其呈现为 null,使标签保持隐藏,而不是把 "HEAD" 这个词
  // 当作分支名渲染出来。
  return {
    isGitRepo: true,
    currentBranch: branch === "HEAD" || branch.length === 0 ? null : branch,
  };
};

export const listLocalBranches = async (
  absPath: string,
  spawnFn: typeof spawn = spawn,
): Promise<LocalBranchSummary[]> => {
  const res = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    { cwd: absPath, spawnFn },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `git for-each-ref failed: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((name) => ({ name, protected: false }));
};
