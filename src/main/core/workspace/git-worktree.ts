import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit, withCloneLock } from "./clone-cache";

export interface IsolatedGitWorktree {
  cleanup: () => Promise<void>;
  diff: () => Promise<{
    diff: string;
    status: string;
    untrackedFiles: string[];
  }>;
  sourcePath: string;
  workspacePath: string;
}

interface PrepareIsolatedGitWorktreeDeps {
  id?: string;
  makeTempDir?: () => Promise<string>;
  removeDir?: (workspacePath: string) => Promise<void>;
  runGit?: typeof runGit;
}

const makeWorktreeDir = (id: string | undefined): Promise<string> => {
  const safeId = (id ?? "run").replace(/[^a-zA-Z0-9_-]/g, "-");
  return mkdtemp(path.join(tmpdir(), `filework-worktree-${safeId}-`));
};

const removeWorktreeDir = async (workspacePath: string): Promise<void> => {
  await rm(workspacePath, { force: true, recursive: true });
};

export const prepareIsolatedGitWorktree = async (
  sourcePath: string,
  {
    id,
    makeTempDir = () => makeWorktreeDir(id),
    removeDir = removeWorktreeDir,
    runGit: git = runGit,
  }: PrepareIsolatedGitWorktreeDeps = {},
): Promise<IsolatedGitWorktree> => {
  const probe = await git(["rev-parse", "--is-inside-work-tree"], {
    cwd: sourcePath,
  });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    throw new Error("Isolated worktree mode requires a git workspace.");
  }

  return withCloneLock(sourcePath, async () => {
    const workspacePath = await makeTempDir();
    const add = await git(
      ["worktree", "add", "--detach", workspacePath, "HEAD"],
      { cwd: sourcePath },
    );

    if (add.exitCode !== 0) {
      await removeDir(workspacePath);
      throw new Error(
        `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`,
      );
    }

    return {
      cleanup: async () => {
        await git(["worktree", "remove", "--force", workspacePath], {
          cwd: sourcePath,
        }).catch(() => undefined);
        await removeDir(workspacePath);
      },
      diff: async () => {
        const untracked = await git(
          ["ls-files", "--others", "--exclude-standard"],
          { cwd: workspacePath },
        );
        // Intent-to-add makes untracked text files appear in `git diff`
        // without committing or staging content in the source worktree.
        await git(["add", "-N", "."], { cwd: workspacePath }).catch(
          () => undefined,
        );
        const [status, diff] = await Promise.all([
          git(["status", "--short"], { cwd: workspacePath }),
          git(["diff", "--binary", "--no-ext-diff"], { cwd: workspacePath }),
        ]);
        return {
          diff: diff.stdout,
          status: status.stdout,
          untrackedFiles:
            untracked.exitCode === 0
              ? untracked.stdout
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
              : [],
        };
      },
      sourcePath,
      workspacePath,
    };
  });
};
