/**
 * Workspace factory — turns a `WorkspaceRef` into a runtime `Workspace`.
 *
 * Used by `ipc/ai-handlers.ts` and `ipc/chat-handlers.ts` whenever they
 * need a workspace for a task. Building Workspace per-task is intentional:
 * it keeps the AgentLoop boundary clean and lets GitHubWorkspace re-check
 * clone freshness on every entry point without a cache-invalidation dance.
 */

import { GitHubWorkspace } from "./github-workspace";
import { GitLabWorkspace } from "./gitlab-workspace";
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
}

export interface CreateWorkspaceOpts {
  /**
   * Per-session scope for SCM-backed auto-branching. The factory
   * forwards this to GitHubWorkspace / GitLabWorkspace; commits land on
   * `claude/<sessionScope>`. Local refs ignore it.
   */
  sessionScope?: string;
}

export const createWorkspace = async (
  ref: WorkspaceRef,
  deps: WorkspaceFactoryDeps,
  opts: CreateWorkspaceOpts = {},
): Promise<Workspace> => {
  if (ref.kind === "local") {
    return new LocalWorkspace(ref.path);
  }
  if (ref.kind === "github") {
    return GitHubWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.githubCacheDir,
      askpassPath: deps.askpassPath,
      sessionScope: opts.sessionScope,
    });
  }
  if (ref.kind === "gitlab") {
    return GitLabWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.gitlabCacheDir,
      askpassPath: deps.askpassPath,
      sessionScope: opts.sessionScope,
    });
  }
  const _exhaustive: never = ref;
  throw new Error(`Unsupported workspace kind: ${JSON.stringify(_exhaustive)}`);
};
