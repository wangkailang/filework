/**
 * Renderer-side mirror of `src/main/core/workspace/workspace-ref.ts`.
 *
 * The renderer process can't import from `src/main/*` (different Vite
 * bundle, different Node availability), so this file duplicates the
 * type and helpers. Keep in sync with the main copy.
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

export const workspaceRefId = (r: WorkspaceRef): string =>
  r.kind === "local"
    ? `local:${r.path}`
    : `github:${r.owner}/${r.repo}@${r.ref}`;

export const encodeRef = (r: WorkspaceRef): string => JSON.stringify(r);

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

export const workspaceRefLabel = (r: WorkspaceRef): string => {
  if (r.kind === "local") {
    const segments = r.path.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? r.path;
  }
  return `${r.owner}/${r.repo}@${r.ref}`;
};
