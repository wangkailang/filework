/**
 * GitHubWorkspace / GitLabWorkspace 共享的克隆缓存工具。
 *
 * 这里集中处理三件事,使两个 provider 行为一致:
 *
 *   1. 按目录串行化(`withCloneLock`)。每仓库一个克隆的布局意味着
 *      两个并发任务若针对同一仓库的不同分支,否则会互相干扰各自的
 *      `git checkout`。我们在目录级别串行化,而非使用进程级全局锁,
 *      以便不同仓库保持并行。
 *
 *   2. 分支切换(`checkoutBranchTo`)。拒绝在脏工作树上操作 —— 抛出
 *      `DirtyTreeError`,而非静默 stash 或覆盖。若本地分支尚不存在,
 *      则创建并跟踪 `origin/<branch>`。
 *
 *   3. 旧缓存迁移(`cleanupLegacyAtRefCache`)。来自分支切换之前各
 *      里程碑的旧 `<project>@<ref>` 目录布局,与新的「每仓库一个
 *      克隆」设计不兼容;在任何工作区物化之前于启动时清扫,使用户
 *      不会在失效克隆上浪费磁盘。
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// 锁
// ---------------------------------------------------------------------------

const cloneLocks = new Map<string, Promise<void>>();

/**
 * 串行化针对单个克隆目录的操作。针对不同目录的多个调用者并行运行;
 * 针对同一目录的多个调用者排队。
 */
export const withCloneLock = async <T>(
  cloneDir: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = cloneLocks.get(cloneDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => current);
  cloneLocks.set(cloneDir, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // 仅当没有后续调用者链接到我们时才清除。否则针对同一目录的
    // 后续 withCloneLock 会跳过等待。
    if (cloneLocks.get(cloneDir) === chained) {
      cloneLocks.delete(cloneDir);
    }
  }
};

// ---------------------------------------------------------------------------
// runGit(provider 辅助函数的镜像,导出给 `local-git.ts` 等兄弟模块,
// 它们需要调用 git 而不必引入整个 Workspace 类)
// ---------------------------------------------------------------------------

export const runGit = async (
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: typeof nodeSpawn;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const sp = opts.spawnFn ?? nodeSpawn;
  return new Promise((resolve, reject) => {
    const child = sp("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
};

// ---------------------------------------------------------------------------
// 分支切换
// ---------------------------------------------------------------------------

/**
 * 当在存在未提交更改的克隆上请求分支切换时抛出。上层(IPC handler、
 * SCM 工具)会将其转换为面向用户的 "commit, stash, or discard first"
 * 错误。
 */
export class DirtyTreeError extends Error {
  constructor(
    public readonly cloneDir: string,
    public readonly targetBranch: string,
  ) {
    super(
      `Working tree at ${cloneDir} has uncommitted changes — refusing to switch to "${targetBranch}". Commit, stash, or discard first.`,
    );
    this.name = "DirtyTreeError";
  }
}

const currentBranchOf = async (
  cloneDir: string,
  spawnFn?: typeof nodeSpawn,
): Promise<string> => {
  const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: cloneDir,
    spawnFn,
  });
  return stdout.trim();
};

const isCleanTree = async (
  cloneDir: string,
  spawnFn?: typeof nodeSpawn,
): Promise<boolean> => {
  const { stdout } = await runGit(["status", "--porcelain"], {
    cwd: cloneDir,
    spawnFn,
  });
  return stdout.trim().length === 0;
};

const localBranchExists = async (
  cloneDir: string,
  branch: string,
  spawnFn?: typeof nodeSpawn,
): Promise<boolean> => {
  const { exitCode } = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: cloneDir, spawnFn },
  );
  return exitCode === 0;
};

/**
 * 将工作树切换到 `branch`。已在该分支上时为空操作。若本地分支尚不
 * 存在,则创建并跟踪 `origin/<branch>`。当工作树存在未提交更改时
 * 抛出 `DirtyTreeError` —— 绝不自动 stash。
 */
export const checkoutBranchTo = async (
  cloneDir: string,
  branch: string,
  spawnFn?: typeof nodeSpawn,
): Promise<void> => {
  const cur = await currentBranchOf(cloneDir, spawnFn);
  if (cur === branch) return;
  if (!(await isCleanTree(cloneDir, spawnFn))) {
    throw new DirtyTreeError(cloneDir, branch);
  }
  if (await localBranchExists(cloneDir, branch, spawnFn)) {
    const res = await runGit(["checkout", branch], {
      cwd: cloneDir,
      spawnFn,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `git checkout ${branch} failed: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
  } else {
    const res = await runGit(["checkout", "-B", branch, `origin/${branch}`], {
      cwd: cloneDir,
      spawnFn,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `git checkout -B ${branch} origin/${branch} failed: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// 旧缓存迁移
// ---------------------------------------------------------------------------

/**
 * 递归扫描每个 `<root>`,查找名称包含 `@` 的目录 —— 即分支切换之前
 * `<project>@<ref>` 布局的标记 —— 并删除那些确实看起来像克隆的目录
 * (包含 `.git` 子目录)。幂等,且对不存在的 root 调用是安全的。
 *
 * 新布局绝不会产生带 `@` 的目录名,因此对我们控制的缓存目录而言,
 * 这一判定毫无歧义。
 */
export const cleanupLegacyAtRefCache = async (
  roots: string[],
): Promise<{ removed: number }> => {
  let removed = 0;
  for (const root of roots) {
    removed += await sweep(root);
  }
  return { removed };
};

const sweep = async (dir: string): Promise<number> => {
  let removed = 0;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name.includes("@")) {
      // 旧布局将 ref 编码为路径组件,因此像 "feature/v1.3" 这样
      // 带斜杠的 ref 会产生嵌套克隆(`<project>@feature/v1.3/.git`)。
      // 探测整个子树而非仅直接子目录 —— 否则带斜杠 ref 的克隆会
      // 漏过。
      if (await subtreeContainsGitDir(child)) {
        await rm(child, { recursive: true, force: true });
        removed += 1;
        continue;
      }
    }
    removed += await sweep(child);
  }
  return removed;
};

const MAX_LEGACY_REF_DEPTH = 6;

const subtreeContainsGitDir = async (
  dir: string,
  depth = 0,
): Promise<boolean> => {
  try {
    const st = await stat(path.join(dir, ".git"));
    if (st.isDirectory()) return true;
  } catch {
    // 不在此层级 —— 再深入一层尝试。
  }
  if (depth >= MAX_LEGACY_REF_DEPTH) return false;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    if (await subtreeContainsGitDir(path.join(dir, entry.name), depth + 1)) {
      return true;
    }
  }
  return false;
};

// 仅供测试的重新导出。
export const __test__ = {
  runGit,
  isCleanTree,
  localBranchExists,
  currentBranchOf,
  sweep,
};
