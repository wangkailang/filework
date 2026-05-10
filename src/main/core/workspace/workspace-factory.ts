/**
 * Workspace factory — turns a `WorkspaceRef` into a runtime `Workspace`.
 *
 * Used by `ipc/ai-handlers.ts` and `ipc/chat-handlers.ts` whenever they
 * need a workspace for a task. Building Workspace per-task is intentional:
 * it keeps the AgentLoop boundary clean and lets GitHubWorkspace re-check
 * clone freshness on every entry point without a cache-invalidation dance.
 */

import { GitHubWorkspace } from "./github-workspace";
import { LocalWorkspace } from "./local-workspace";
import type { Workspace } from "./types";
import type { WorkspaceRef } from "./workspace-ref";

export interface WorkspaceFactoryDeps {
  /** Decrypts a stored credential id into the underlying token. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Root for ephemeral GitHub clones. */
  githubCacheDir: string;
}

export const createWorkspace = async (
  ref: WorkspaceRef,
  deps: WorkspaceFactoryDeps,
): Promise<Workspace> => {
  if (ref.kind === "local") {
    return new LocalWorkspace(ref.path);
  }
  if (ref.kind === "github") {
    return GitHubWorkspace.create(ref, {
      resolveToken: deps.resolveToken,
      cacheDir: deps.githubCacheDir,
    });
  }
  const _exhaustive: never = ref;
  throw new Error(`Unsupported workspace kind: ${JSON.stringify(_exhaustive)}`);
};
