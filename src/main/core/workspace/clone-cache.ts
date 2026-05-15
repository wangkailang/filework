/**
 * Shared clone-cache utilities for GitHubWorkspace / GitLabWorkspace.
 *
 * Three concerns live here so both providers behave identically:
 *
 *   1. Per-directory serialization (`withCloneLock`). The clone-per-repo
 *      layout means two concurrent tasks targeting the same repo on
 *      different branches would otherwise step on each other's
 *      `git checkout`. We serialize at the directory level rather than
 *      with a process-wide lock so different repos stay parallel.
 *
 *   2. Branch switching (`checkoutBranchTo`). Refuses to operate on a
 *      dirty tree — surfaces a `DirtyTreeError` instead of silently
 *      stashing or clobbering. If the local branch doesn't exist yet,
 *      creates it tracking `origin/<branch>`.
 *
 *   3. Legacy-cache migration (`cleanupLegacyAtRefCache`). The old
 *      `<project>@<ref>` directory layout from pre-branch-switch
 *      milestones is incompatible with the new "one clone per repo"
 *      design; sweep them up at startup before any workspace is
 *      materialized so users don't waste disk on dead clones.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

const cloneLocks = new Map<string, Promise<void>>();

/**
 * Serialize operations against a single clone directory. Multiple
 * callers targeting different directories run in parallel; multiple
 * callers on the same directory queue.
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
    // Only clear if no later caller has chained onto us. Otherwise
    // a subsequent withCloneLock for the same dir would skip the wait.
    if (cloneLocks.get(cloneDir) === chained) {
      cloneLocks.delete(cloneDir);
    }
  }
};

// ---------------------------------------------------------------------------
// runGit (mirror of the providers' helper, exported for sibling modules
// like `local-git.ts` that need to invoke git without pulling in a whole
// Workspace class)
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
// Branch switching
// ---------------------------------------------------------------------------

/**
 * Thrown when a branch switch is requested on a clone with uncommitted
 * changes. Upper layers (IPC handlers, SCM tools) translate this into a
 * user-visible "commit, stash, or discard first" error.
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
 * Switch the working tree to `branch`. No-op when already on it. If
 * the local branch doesn't exist yet, creates it tracking
 * `origin/<branch>`. Throws `DirtyTreeError` when the tree has
 * uncommitted changes — never auto-stashes.
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
// Legacy-cache migration
// ---------------------------------------------------------------------------

/**
 * Recursively sweep each `<root>` for directories whose name contains
 * `@` — the marker of the pre-branch-switch `<project>@<ref>` layout —
 * and delete those that actually look like clones (contain a `.git`
 * subdirectory). Idempotent and safe to call on a missing root.
 *
 * The new layout never produces directory names with `@`, so this is
 * unambiguous for cache directories we control.
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
      // Legacy layout encoded the ref as a path component, so refs
      // with slashes like "feature/v1.3" produce nested clones
      // (`<project>@feature/v1.3/.git`). Probe the whole subtree
      // rather than only the immediate child — otherwise slash-ref
      // clones leak through.
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
    // Not at this level — try one level deeper.
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

// Test-only re-exports.
export const __test__ = {
  runGit,
  isCleanTree,
  localBranchExists,
  currentBranchOf,
  sweep,
};
