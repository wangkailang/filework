/**
 * Workspace factory — turns a `WorkspaceRef` into a runtime `Workspace`.
 *
 * Used by `ipc/ai-handlers.ts` and `ipc/chat-handlers.ts` whenever they
 * need a workspace for a task. Building Workspace per-task is intentional:
 * it keeps the AgentLoop boundary clean and lets GitHubWorkspace re-check
 * clone freshness on every entry point without a cache-invalidation dance.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ProxyResolver } from "./git-proxy-env";
import { GitHubWorkspace } from "./github-workspace";
import { GitLabWorkspace } from "./gitlab-workspace";
import { startHeadWatcher } from "./head-watcher";
import { LocalWorkspace } from "./local-workspace";
import type { Workspace } from "./types";
import type { WorkspaceRef } from "./workspace-ref";

export interface WorkspaceFactoryDeps {
  /** Decrypts a stored credential id into the underlying token. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Root for ephemeral GitHub clones. */
  githubCacheDir: string;
  /** Root for ephemeral GitLab clones. */
  gitlabCacheDir: string;
  /**
   * Absolute path to the GIT_ASKPASS helper. Wired by main bootstrap
   * via `git-credentials.ts:ensureAskpassScript()`. When omitted (e.g.
   * in tests), git invocations fall back to inheriting `process.env`.
   */
  askpassPath?: string;
  /**
   * Per-host proxy resolver for spawned `git` children (see
   * `git-proxy-env.ts`). Wired by `index.ts` to
   * `session.defaultSession.resolveProxy`.
   */
  resolveProxy?: ProxyResolver;
}

export const createWorkspace = async (
  ref: WorkspaceRef,
  deps: WorkspaceFactoryDeps,
): Promise<Workspace> => {
  if (ref.kind === "local") {
    // Idempotent — no-op for non-git directories (startHeadWatcher
    // returns early when .git/HEAD can't be read). Gives local repos
    // the same chat-driven-checkout sync as remote workspaces.
    void startHeadWatcher(ref.path);
    return new LocalWorkspace(ref.path);
  }
  if (ref.kind === "github") {
    return GitHubWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.githubCacheDir,
      askpassPath: deps.askpassPath,
      resolveProxy: deps.resolveProxy,
    });
  }
  if (ref.kind === "gitlab") {
    return GitLabWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.gitlabCacheDir,
      askpassPath: deps.askpassPath,
      resolveProxy: deps.resolveProxy,
    });
  }
  const _exhaustive: never = ref;
  throw new Error(`Unsupported workspace kind: ${JSON.stringify(_exhaustive)}`);
};

/**
 * True when the workspace is git-backed — either a remote-cloned GitHub /
 * GitLab workspace, or a LocalWorkspace whose root contains a `.git`
 * entry. Used by the prompt builders to gate injection of the L1 git
 * principles block and by `buildAgentToolRegistry` to gate the L2
 * protocol embedded in `runCommand`'s description.
 *
 * Sync `existsSync` is intentional: the check runs once per task on
 * worktree paths the main process already trusts. An async check would
 * force the call sites (system prompt + tool registry build) to become
 * async without a real benefit.
 *
 * `.git` may be a file (worktree / submodule) instead of a directory,
 * so this only tests for presence, not directory-ness.
 */
export const isGitBackedWorkspace = (workspace: Workspace): boolean => {
  if (workspace.kind !== "local") return true;
  return existsSync(path.join(workspace.root, ".git"));
};
