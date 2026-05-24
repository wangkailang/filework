/**
 * Branch-level diff shapes — what the right-side drawer renders to show
 * the current branch's accumulated changes against its base (default
 * `main`). The data model deliberately reuses {@link PreviewDiffHunk}
 * from the codex-style per-tool preview so the renderer can feed both
 * the per-tool approval cards and the aggregate drawer through the
 * same {@link DiffHunkView}.
 *
 * Plain JSON; transported via `ipcRenderer.invoke("git:getBranchDiff", …)`.
 */

import type { PreviewDiffHunk } from "../agent/preview/types";

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitFileDiff {
  /** Post-rename path; for added/modified/deleted this is the canonical path. */
  path: string;
  /** Set only on renames; the previous path. */
  oldPath?: string;
  status: GitFileStatus;
  added: number;
  removed: number;
  isBinary: boolean;
  /** Empty when binary or truncated. */
  hunks: PreviewDiffHunk[];
  /** Per-file truncation: too many hunks or single hunk too large. */
  truncated?: boolean;
}

export type BranchDiffNotAvailable =
  | "not-git"
  | "no-base"
  | "exec-failed"
  | "no-head";

export interface BranchDiff {
  /** Short SHA of the merge-base used to compute the diff. */
  base: string;
  /** User-facing label for the base — `"origin/main"` when the remote
   *  ref is reachable, otherwise the plain local branch name. */
  baseRef?: string;
  baseBranch: string;
  head: string;
  headBranch: string;
  files: GitFileDiff[];
  totalAdded: number;
  totalRemoved: number;
  /** Commits on HEAD that aren't on `origin/<currentBranch>` (i.e.
   *  unpushed). Undefined when the local branch has no upstream. */
  ahead?: number;
  /** Commits on `origin/<currentBranch>` that aren't on HEAD (need pull). */
  behind?: number;
  /** Files with staged / unstaged / untracked changes (git status
   *  --porcelain; .gitignore'd paths excluded by porcelain itself). */
  uncommitted?: number;
  /** True when the result was capped (>200 files or aggregate size). */
  truncated?: boolean;
  /** Set when the diff couldn't be produced. UI shows a matching empty state. */
  notAvailable?: BranchDiffNotAvailable;
  /** Free-text reason — pass-through of git stderr or thrown error message. */
  errorMessage?: string;
}
