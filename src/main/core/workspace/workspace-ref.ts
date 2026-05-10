/**
 * WorkspaceRef — identity of a workspace at the IPC and persistence layer.
 *
 * Distinct from `Workspace`:
 *   - `Workspace` is the runtime object tools operate on (fs/exec/scm).
 *   - `WorkspaceRef` is the *handle* that uniquely names "which workspace"
 *     and survives serialization across IPC, disk, and (eventually) sync.
 *
 * The renderer state and `recent_workspaces` rows hold a `WorkspaceRef`.
 * The factory (`workspace-factory.ts`) builds a concrete `Workspace` from
 * a ref each time a task starts.
 */

export type WorkspaceRef =
  | { kind: "local"; path: string }
  | {
      kind: "github";
      owner: string;
      repo: string;
      ref: string;
      credentialId: string;
    };

/**
 * Stable identifier for a workspace ref. Used as the input to
 * `workspaceKey()` for JSONL session bucketing, and as a sidebar/log
 * display key. Independent of credential rotation — re-issuing a PAT
 * for the same `(owner, repo, ref)` keeps the same id and the same
 * session history.
 */
export const workspaceRefId = (r: WorkspaceRef): string =>
  r.kind === "local"
    ? `local:${r.path}`
    : `github:${r.owner}/${r.repo}@${r.ref}`;

/** Encode for `recent_workspaces.metadata` (TEXT column, JSON). */
export const encodeRef = (r: WorkspaceRef): string => JSON.stringify(r);

/**
 * Parse a stored ref. Returns `null` if the input is not valid JSON or
 * doesn't match a known shape — callers fall back to the legacy `path`
 * column in that case.
 */
export const decodeRef = (
  s: string | null | undefined,
): WorkspaceRef | null => {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.kind === "local" && typeof obj.path === "string") {
      return { kind: "local", path: obj.path };
    }
    if (
      obj.kind === "github" &&
      typeof obj.owner === "string" &&
      typeof obj.repo === "string" &&
      typeof obj.ref === "string" &&
      typeof obj.credentialId === "string"
    ) {
      return {
        kind: "github",
        owner: obj.owner,
        repo: obj.repo,
        ref: obj.ref,
        credentialId: obj.credentialId,
      };
    }
    return null;
  } catch {
    return null;
  }
};

/** Human-readable label for sidebar / titles. */
export const workspaceRefLabel = (r: WorkspaceRef): string => {
  if (r.kind === "local") {
    const segments = r.path.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? r.path;
  }
  return `${r.owner}/${r.repo}@${r.ref}`;
};
