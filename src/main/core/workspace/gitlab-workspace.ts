/**
 * GitLabWorkspace — Workspace backed by an ephemeral local clone of a
 * GitLab project (gitlab.com or self-hosted).
 *
 * Mirrors `github-workspace.ts` in structure and design. Key differences:
 *   - Authed clone URL uses `oauth2:<token>@<host>/<namespace>/<project>.git`
 *     (GitLab's recommended username for token auth).
 *   - Clone layout includes the host (`<cacheDir>/<host>/<namespace>/<project>/`)
 *     so the same `<namespace>/<project>` on different GitLab instances
 *     doesn't collide.
 *
 * After the clone is materialized, fs/exec are delegated to an internal
 * `LocalWorkspace`. The agent drives git through `runCommand` against
 * the authenticated clone (`git`, `glab`); user approval on each
 * runCommand is the safety net.
 *
 * `scm` exposes a host-only branch picker — `currentBranch` +
 * `checkoutBranch` — used by the renderer's switch-branch UI.
 *
 * Token handling: the PAT flows through the `GIT_ASKPASS` helper, never
 * embedded in the on-disk remote URL.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkoutBranchTo, withCloneLock } from "./clone-cache";
import {
  buildAskpassEnv,
  gitlabSanitizedRemote,
  normalizeGitLabHost,
} from "./git-credentials";
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

export interface GitLabRef {
  kind: "gitlab";
  host: string;
  namespace: string;
  project: string;
  ref: string;
  credentialId: string;
}

export interface GitLabWorkspaceDeps {
  /** Returns a decrypted PAT for the credential id. Throws if missing. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Root for ephemeral clones, e.g. `~/.filework/cache/gitlab`. */
  cacheDir: string;
  /**
   * Absolute path to the GIT_ASKPASS helper script. Production wires
   * this from `git-credentials.ts:ensureAskpassScript()`. See
   * `github-workspace.ts:GitHubWorkspaceDeps.askpassPath` for details.
   */
  askpassPath?: string;
  /** Default 1 hour. After this, GitLabWorkspace.create() refreshes. */
  freshnessTtlMs?: number;
  /** Override the spawn implementation in tests. */
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
 * workspace as "dirty". Mirrors `github-workspace.ts`.
 */
const LAST_FETCH_FILE = ".git/filework-last-fetch";
/** Pre-fix location at the working-tree root; removed on first encounter. */
const LEGACY_LAST_FETCH_FILE = ".last-fetch";

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
 * Clone dir layout: `<cacheDir>/<host>/<namespace>/<project>/`. One
 * clone per project — switching branches mutates this same directory.
 * Host is included so the same `<namespace>/<project>` on different
 * GitLab instances doesn't collide.
 */
const cloneDirFor = (cacheDir: string, ref: GitLabRef): string =>
  path.join(cacheDir, ref.host, ref.namespace, ref.project);

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
 * Materialize the clone for `ref`. One clone per project — `ref.ref`
 * is the initial branch (passed to `git clone -b`), not part of the
 * directory path. Mirrors `github-workspace.ts:ensureClone`; see that
 * file for the design rationale.
 */
export const ensureClone = async (
  ref: GitLabRef,
  deps: GitLabWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  return withCloneLock(cloneDir, async () => {
    const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
    const exists = await cloneExists(cloneDir);

    if (exists && (await isFresh(cloneDir, ttlMs))) {
      return cloneDir;
    }

    const token = await deps.resolveToken(ref.credentialId);
    const remote = gitlabSanitizedRemote(ref.host, ref.namespace, ref.project);
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
      // Stale refresh: re-sanitize remote URL, fetch all refs. No
      // `reset --hard` — preserves session branches' uncommitted work.
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
    // `.git/`. See github-workspace.ts:ensureClone for the rationale.
    await rm(path.join(cloneDir, LEGACY_LAST_FETCH_FILE), { force: true });

    await stamp(cloneDir);
    return cloneDir;
  });
};

interface GitLabScmDeps {
  cloneDir: string;
  host: string;
  namespace: string;
  project: string;
  resolveToken: () => Promise<string>;
  askpassPath?: string;
  spawnFn?: typeof spawn;
  resolveProxy?: ProxyResolver;
}

/**
 * Host-only SCM helper. Exposes only the branch-picker affordances the
 * renderer needs — the agent drives all other git operations through
 * `runCommand`.
 */
class GitLabWorkspaceSCM implements WorkspaceSCM {
  constructor(private readonly deps: GitLabScmDeps) {}

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
      const remote = gitlabSanitizedRemote(
        this.deps.host,
        this.deps.namespace,
        this.deps.project,
      );
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

export class GitLabWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "gitlab";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm: WorkspaceSCM;

  private constructor(
    ref: GitLabRef,
    cloneDir: string,
    local: LocalWorkspace,
    deps: GitLabWorkspaceDeps,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = local.exec;
    this.scm = new GitLabWorkspaceSCM({
      cloneDir,
      host: ref.host,
      namespace: ref.namespace,
      project: ref.project,
      resolveToken: () => deps.resolveToken(ref.credentialId),
      askpassPath: deps.askpassPath,
      spawnFn: deps.spawnFn,
      resolveProxy: deps.resolveProxy,
    });
  }

  static async create(
    ref: GitLabRef,
    deps: GitLabWorkspaceDeps,
  ): Promise<GitLabWorkspace> {
    // Defensive normalize: pre-fix builds persisted host with `https://`
    // baked in, and the workspace-factory replays those refs verbatim.
    const cleanRef: GitLabRef = {
      ...ref,
      host: normalizeGitLabHost(ref.host),
    };
    const cloneDir = await ensureClone(cleanRef, deps);
    // Idempotent — first call per cloneDir installs the watcher;
    // subsequent calls are no-ops. Errors are swallowed inside.
    void startHeadWatcher(cloneDir);
    const local = new LocalWorkspace(cloneDir, {
      id: workspaceRefId(cleanRef),
    });
    return new GitLabWorkspace(cleanRef, cloneDir, local, deps);
  }
}

export const __test__ = {
  cloneDirFor,
  isFresh,
  stamp,
};
