import { createHash } from "node:crypto";

/**
 * Hash a workspace path into a filesystem-safe directory name.
 *
 * Returns the first 16 hex characters of the sha256 of the UTF-8 path.
 * Matches PI's convention so a future co-located SDK can read the same
 * tree. Collision space is 2^64 ≈ 1.8e19 — comfortable for any realistic
 * workspace count.
 *
 * The input is not normalized — different path strings ("/foo" vs
 * "/foo/") hash differently. Callers (chat IPC handlers) are the source
 * of truth for the canonical path passed through.
 */
export function workspaceKey(workspacePath: string): string {
  return createHash("sha256")
    .update(workspacePath, "utf8")
    .digest("hex")
    .slice(0, 16);
}
