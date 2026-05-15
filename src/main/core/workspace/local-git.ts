/**
 * local-git — git operations for *local* (non-clone) workspaces.
 *
 * The github/gitlab workspace classes own clone freshness, auth, and
 * remote-tracking semantics; locals have none of that. This module
 * exposes the two operations the renderer needs to show a branch chip:
 *
 *   - `probeLocalGit` — is this directory a git repo? if so, what's HEAD?
 *   - `listLocalBranches` — local refs/heads/* only (no remote-tracking).
 *
 * Branch switching reuses `checkoutBranchTo` from `clone-cache.ts` —
 * same dirty-tree refusal, same lock semantics.
 *
 * Detached HEAD is reported as `currentBranch: null` so the renderer can
 * suppress the branch chip rather than render a misleading "branch" name.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { runGit } from "./clone-cache";

export interface LocalGitProbe {
  isGitRepo: boolean;
  /** Branch name, or null for detached HEAD / non-git directories. */
  currentBranch: string | null;
}

export interface LocalBranchSummary {
  name: string;
  /** Always false locally — protection is a hosted-provider concept. */
  protected: boolean;
}

const isGitDir = async (absPath: string): Promise<boolean> => {
  try {
    const st = await stat(path.join(absPath, ".git"));
    // `.git` is a directory in a normal repo, a file in a worktree.
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
  // `rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when
  // detached — surface that as null so the chip stays hidden instead
  // of rendering the word "HEAD" as if it were a branch name.
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
