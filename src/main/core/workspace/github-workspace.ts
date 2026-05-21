/**
 * GitHubWorkspace — Workspace backed by an ephemeral local clone of a
 * GitHub repository.
 *
 * Layout: `<cacheDir>/<owner>/<repo>/` holds a single partial clone of
 * `https://github.com/<owner>/<repo>` (`--filter=blob:none` — all refs
 * available, blobs fetched on demand). Switching branches mutates this
 * same directory via `git checkout`, the same mental model as a local
 * git project. A sibling `.git/filework-last-fetch` file timestamps the
 * most recent `git fetch` so freshness checks don't re-walk the working
 * tree.
 *
 * After the clone is materialized, fs/exec are delegated to an internal
 * `LocalWorkspace` pointing at the clone — the existing tool registry
 * works without modification. The agent drives git through `runCommand`
 * against the authenticated clone (`git`, `gh`); user approval on each
 * runCommand is the safety net, replacing the typed SCM tools that used
 * to gate writes server-side.
 *
 * `scm` exposes a host-only branch picker — `currentBranch` +
 * `checkoutBranch` — used by the renderer's switch-branch UI. The agent
 * itself never reaches for `scm`; it `git checkout`s through runCommand.
 *
 * Token handling: the PAT flows through the `GIT_ASKPASS` helper, never
 * embedded in the on-disk remote URL.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkoutBranchTo, withCloneLock } from "./clone-cache";
import { buildAskpassEnv, githubSanitizedRemote } from "./git-credentials";
import { buildGitProxyEnv, type ProxyResolver } from "./git-proxy-env";
import { startHeadWatcher } from "./head-watcher";
import { LocalWorkspace } from "./local-workspace";
import type {
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
   * Absolute path to the GIT_ASKPASS helper script. Production wires
   * this from `git-credentials.ts:ensureAskpassScript()`. Tests can
   * leave it undefined — `runGit` falls back to plain spawn without
   * setting the env, which is fine because the test stub for `git`
   * never actually authenticates.
   */
  askpassPath?: string;
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
  /**
   * Per-host proxy resolver (Chromium PAC output: "DIRECT" / "PROXY h:p").
   * Wired by `index.ts` to `session.defaultSession.resolveProxy`. When set,
   * every network-touching git subprocess gets a freshly-built env where
   * HTTPS_PROXY matches the PAC verdict for the actual remote URL —
   * fixes split-routing setups where the global env proxy is wrong for
   * some hosts. Undefined falls back to inherited `process.env`.
   */
  resolveProxy?: ProxyResolver;
}

/**
 * Build the env to pass to `runGit` for an authenticated invocation.
 * Returns `undefined` (i.e. inherit `process.env`) when askpass isn't
 * configured — useful in tests that mock spawn entirely.
 */
const authedEnv = (
  askpassPath: string | undefined,
  token: string,
): NodeJS.ProcessEnv | undefined =>
  askpassPath ? buildAskpassEnv({ askpassPath, password: token }) : undefined;

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/**
 * Stamp file path *relative to the clone root*. Lives inside `.git/` so
 * it never appears in `git status --porcelain` — otherwise the clean-tree
 * check used by `checkoutBranch` would always reject a just-cloned
 * workspace as "dirty".
 */
const LAST_FETCH_FILE = ".git/filework-last-fetch";
/** Pre-fix location at the working-tree root; removed on first encounter. */
const LEGACY_LAST_FETCH_FILE = ".last-fetch";

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

/**
 * One clone per `(owner, repo)` — branch is working-tree state, not a
 * path component.
 */
const cloneDirFor = (cacheDir: string, ref: GitHubRef): string =>
  path.join(cacheDir, ref.owner, ref.repo);

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

/**
 * Materialize the clone for `ref` at `cloneDir`. One clone per repo —
 * `ref.ref` is the *initial branch* (used by `git clone -b`), not
 * part of the directory path.
 *
 *   - No clone yet → `git clone -b <ref.ref> --filter=blob:none`.
 *     Partial clone: all refs visible (no `--single-branch`), blobs
 *     fetched on demand. Working tree lands on `ref.ref`.
 *   - Clone exists + stale → `git fetch origin` (updates all
 *     remote-tracking refs; does *not* touch the working tree, so
 *     uncommitted agent work or non-default branches survive).
 *   - Clone exists + fresh → no-op.
 *
 * Branch switching after initial clone is an explicit user action —
 * see `checkoutBranch`. ensureClone never auto-switches.
 *
 * Concurrency: wrapped in `withCloneLock(cloneDir)` so concurrent
 * creators of the same workspace queue rather than racing on
 * filesystem state.
 *
 * Auth: the remote URL is sanitized (no token), and the token is
 * passed via GIT_ASKPASS env. Refresh paths re-write the remote URL
 * to scrub any pre-M7 token leak.
 */
export const ensureClone = async (
  ref: GitHubRef,
  deps: GitHubWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  return withCloneLock(cloneDir, async () => {
    const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
    const exists = await cloneExists(cloneDir);

    if (exists && (await isFresh(cloneDir, ttlMs))) {
      return cloneDir;
    }

    const token = await deps.resolveToken(ref.credentialId);
    const remote = githubSanitizedRemote(ref.owner, ref.repo);
    const env = await buildGitProxyEnv(
      authedEnv(deps.askpassPath, token) ?? process.env,
      remote,
      deps.resolveProxy,
    );

    if (!exists) {
      await mkdir(path.dirname(cloneDir), { recursive: true });
      try {
        await runGit(
          [
            "clone",
            "--filter=blob:none",
            "--branch",
            ref.ref,
            remote,
            cloneDir,
          ],
          { spawnFn: deps.spawnFn, env },
        );
      } catch (err) {
        await rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    } else {
      // Stale refresh: re-sanitize remote (covers pre-M7 clones whose
      // .git/config still has an embedded token), then fetch every
      // ref. No `reset --hard` — the working tree carries session
      // branches we must not clobber.
      await runGit(["remote", "set-url", "origin", remote], {
        cwd: cloneDir,
        spawnFn: deps.spawnFn,
      });
      await runGit(["fetch", "origin"], {
        cwd: cloneDir,
        spawnFn: deps.spawnFn,
        env,
      });
    }

    // Drop any legacy root-level stamp file from before it moved into
    // `.git/`. Otherwise `git status --porcelain` reports it as `??` and
    // every clone looks "dirty" to `checkoutBranch`.
    await rm(path.join(cloneDir, LEGACY_LAST_FETCH_FILE), { force: true });

    await stamp(cloneDir);
    return cloneDir;
  });
};

interface GitHubScmDeps {
  cloneDir: string;
  owner: string;
  repo: string;
  resolveToken: () => Promise<string>;
  askpassPath?: string;
  spawnFn?: typeof spawn;
  resolveProxy?: ProxyResolver;
}

/**
 * Host-only SCM helper for git-backed workspaces. Exposes only the
 * branch-picker affordances the renderer needs — the agent drives all
 * other git operations through `runCommand`.
 */
class GitHubWorkspaceSCM implements WorkspaceSCM {
  constructor(private readonly deps: GitHubScmDeps) {}

  private get cwd(): string {
    return this.deps.cloneDir;
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
    return stdout.trim();
  }

  async checkoutBranch(input: {
    branch: string;
  }): Promise<{ branch: string; previousBranch: string }> {
    return withCloneLock(this.cwd, async () => {
      const previousBranch = await this.currentBranch();
      if (previousBranch === input.branch) {
        return { branch: input.branch, previousBranch };
      }
      const token = await this.deps.resolveToken();
      const remote = githubSanitizedRemote(this.deps.owner, this.deps.repo);
      await runGit(["remote", "set-url", "origin", remote], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      });
      await runGit(["fetch", "origin"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
        env: await buildGitProxyEnv(
          authedEnv(this.deps.askpassPath, token) ?? process.env,
          remote,
          this.deps.resolveProxy,
        ),
      });
      await checkoutBranchTo(this.cwd, input.branch, this.deps.spawnFn);
      return { branch: input.branch, previousBranch };
    });
  }
}

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
    deps: GitHubWorkspaceDeps,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = local.exec;
    this.scm = new GitHubWorkspaceSCM({
      cloneDir,
      owner: ref.owner,
      repo: ref.repo,
      resolveToken: () => deps.resolveToken(ref.credentialId),
      askpassPath: deps.askpassPath,
      spawnFn: deps.spawnFn,
      resolveProxy: deps.resolveProxy,
    });
  }

  static async create(
    ref: GitHubRef,
    deps: GitHubWorkspaceDeps,
  ): Promise<GitHubWorkspace> {
    const cloneDir = await ensureClone(ref, deps);
    // Idempotent — first call per cloneDir installs the watcher;
    // subsequent calls are no-ops. Errors are swallowed inside.
    void startHeadWatcher(cloneDir);
    const local = new LocalWorkspace(cloneDir, { id: workspaceRefId(ref) });
    return new GitHubWorkspace(ref, cloneDir, local, deps);
  }
}

export const __test__ = {
  cloneDirFor,
  isFresh,
  stamp,
};
