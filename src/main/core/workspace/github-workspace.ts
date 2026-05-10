/**
 * GitHubWorkspace — Workspace backed by an ephemeral local clone of a
 * GitHub repository.
 *
 * Layout: `<cacheDir>/<owner>/<repo>@<ref>/` holds a shallow clone of
 * `https://github.com/<owner>/<repo>` checked out at `<ref>`. A sibling
 * `.last-fetch` file timestamps the most recent `git fetch` so freshness
 * checks don't re-walk the working tree.
 *
 * After the clone is materialized, fs/exec are delegated to an internal
 * `LocalWorkspace` pointing at the clone — the existing tool registry
 * works without modification. SCM ops in PR 1 only implement
 * status/diff; commit/push throw and ship in M6 PR 2.
 *
 * Token handling: the PAT is injected into the remote URL the first
 * time we clone. Once the remote is set, we run `git fetch` without
 * exposing the token in argv (the URL on disk is the authentication
 * vector). Future hardening: switch to a `GIT_ASKPASS` helper to keep
 * the token out of the on-disk remote URL too.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { LocalWorkspace } from "./local-workspace";
import type {
  ExecOptions,
  ExecResult,
  Workspace,
  WorkspaceExec,
  WorkspaceFS,
  WorkspaceKind,
  WorkspaceSCM,
} from "./types";
import { workspaceRefId } from "./workspace-ref";

export interface GitHubRef {
  kind: "github";
  owner: string;
  repo: string;
  ref: string;
  credentialId: string;
}

export interface GitHubWorkspaceDeps {
  /** Returns a decrypted PAT for the credential id. Throws if missing. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Root for ephemeral clones, e.g. `~/.filework/cache/github`. */
  cacheDir: string;
  /**
   * Clone freshness window in milliseconds. After this much time since
   * the last `git fetch`, GitHubWorkspace.create() refreshes before
   * returning. Defaults to 1 hour.
   */
  freshnessTtlMs?: number;
  /**
   * Override the spawn implementation in tests. Production code uses
   * the default `child_process.spawn`.
   */
  spawnFn?: typeof spawn;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const LAST_FETCH_FILE = ".last-fetch";

/** Run a git subprocess and capture stdout/stderr. Throws on non-zero exit. */
const runGit = async (
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; spawnFn?: typeof spawn } = {},
): Promise<{ stdout: string; stderr: string }> => {
  const sp = opts.spawnFn ?? spawn;
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
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `git ${args[0]} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
  });
};

const cloneDirFor = (cacheDir: string, ref: GitHubRef): string =>
  path.join(cacheDir, ref.owner, `${ref.repo}@${ref.ref}`);

const isFresh = async (cloneDir: string, ttlMs: number): Promise<boolean> => {
  try {
    const st = await stat(path.join(cloneDir, LAST_FETCH_FILE));
    return Date.now() - st.mtimeMs < ttlMs;
  } catch {
    return false;
  }
};

const stamp = async (cloneDir: string): Promise<void> => {
  await writeFile(
    path.join(cloneDir, LAST_FETCH_FILE),
    new Date().toISOString(),
    "utf8",
  );
};

const cloneExists = async (cloneDir: string): Promise<boolean> => {
  try {
    const st = await stat(path.join(cloneDir, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
};

const buildAuthedRemote = (
  token: string,
  owner: string,
  repo: string,
): string =>
  // `x-access-token` is GitHub's recommended username for token auth.
  `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;

/**
 * Materialize the clone for `ref` at `cloneDir`. If the clone is
 * absent, perform a shallow clone. If present and stale, fetch + reset.
 * Returns the local clone directory once the working tree matches `ref.ref`.
 */
export const ensureClone = async (
  ref: GitHubRef,
  deps: GitHubWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
  const exists = await cloneExists(cloneDir);

  if (exists && (await isFresh(cloneDir, ttlMs))) {
    return cloneDir;
  }

  const token = await deps.resolveToken(ref.credentialId);
  const remote = buildAuthedRemote(token, ref.owner, ref.repo);

  if (!exists) {
    await mkdir(path.dirname(cloneDir), { recursive: true });
    try {
      await runGit(
        ["clone", "--depth", "1", "--branch", ref.ref, remote, cloneDir],
        { spawnFn: deps.spawnFn },
      );
    } catch (err) {
      // Failed clone — clean up partial dir to avoid wedging future attempts.
      await rm(cloneDir, { recursive: true, force: true });
      throw err;
    }
  } else {
    // Refresh: rewrite remote with current token, fetch, hard-reset.
    await runGit(["remote", "set-url", "origin", remote], {
      cwd: cloneDir,
      spawnFn: deps.spawnFn,
    });
    await runGit(["fetch", "--depth", "1", "origin", ref.ref], {
      cwd: cloneDir,
      spawnFn: deps.spawnFn,
    });
    await runGit(["reset", "--hard", "FETCH_HEAD"], {
      cwd: cloneDir,
      spawnFn: deps.spawnFn,
    });
  }

  await stamp(cloneDir);
  return cloneDir;
};

class GitHubWorkspaceSCM implements WorkspaceSCM {
  constructor(
    private readonly cloneDir: string,
    private readonly branch: string,
    private readonly spawnFn?: typeof spawn,
  ) {}

  async status(): Promise<{ branch: string; dirty: boolean }> {
    const { stdout } = await runGit(["status", "--porcelain"], {
      cwd: this.cloneDir,
      spawnFn: this.spawnFn,
    });
    return { branch: this.branch, dirty: stdout.trim().length > 0 };
  }

  async diff(rel?: string): Promise<string> {
    const args = ["diff", "--no-color"];
    if (rel) args.push("--", rel);
    const { stdout } = await runGit(args, {
      cwd: this.cloneDir,
      spawnFn: this.spawnFn,
    });
    return stdout;
  }
}

/**
 * Wraps the underlying LocalWorkspace exec to forbid `git push` etc. in
 * PR 1. The agent could otherwise reach the network through `runCommand`
 * even though the SCM surface throws. M6 PR 2 will replace this with a
 * proper write-approval flow.
 */
class GitHubWorkspaceExec implements WorkspaceExec {
  constructor(private readonly inner: WorkspaceExec) {}

  async run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (looksLikeGitWrite(command)) {
      return {
        stdout: "",
        stderr: `Refused: \`${command.split(/\s+/).slice(0, 3).join(" ")}\` — git write ops require M6 PR 2 approval flow.`,
        exitCode: 126,
      };
    }
    return this.inner.run(command, opts);
  }
}

const GIT_WRITE_VERBS = new Set([
  "push",
  "commit",
  "merge",
  "rebase",
  "reset",
  "tag",
  "am",
  "cherry-pick",
  "revert",
]);

/** Best-effort check: matches `git push`, `git -c x=y push --force`, etc. */
const looksLikeGitWrite = (command: string): boolean => {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git") return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    // `-c <key=val>` and `-C <path>` swallow the next token.
    if (t === "-c" || t === "-C") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return GIT_WRITE_VERBS.has(t);
  }
  return false;
};

export class GitHubWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "github";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm: WorkspaceSCM;

  private constructor(
    ref: GitHubRef,
    cloneDir: string,
    local: LocalWorkspace,
    spawnFn?: typeof spawn,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = new GitHubWorkspaceExec(local.exec);
    this.scm = new GitHubWorkspaceSCM(cloneDir, ref.ref, spawnFn);
  }

  static async create(
    ref: GitHubRef,
    deps: GitHubWorkspaceDeps,
  ): Promise<GitHubWorkspace> {
    const cloneDir = await ensureClone(ref, deps);
    const local = new LocalWorkspace(cloneDir, { id: workspaceRefId(ref) });
    return new GitHubWorkspace(ref, cloneDir, local, deps.spawnFn);
  }
}

export const __test__ = { looksLikeGitWrite, cloneDirFor, isFresh, stamp };
