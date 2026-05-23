/**
 * deleteFile preview generator. Inspects the target without removing
 * it: stat for files, recursive list (capped) for directories, and
 * optional head text snippet so the approval card can show *what* is
 * about to be deleted.
 */

import path from "node:path";
import type { Workspace } from "../../workspace/types";
import type { DeleteFilePreview } from "./types";

const HEAD_LINES_MAX = 20;
const HEAD_BYTES_MAX = 2 * 1024;
const CHILD_COUNT_CAP = 5_000;
const HEAD_BINARY_SNIFF_BYTES = 4 * 1024;

interface DeleteFileArgs {
  path: string;
}

export async function computeDeleteFilePreview(
  args: DeleteFileArgs,
  workspace: Workspace,
): Promise<DeleteFilePreview> {
  const rel = await resolveRel(args.path, workspace);
  const exists = await workspace.fs.exists(rel).catch(() => false);
  if (!exists) {
    return {
      kind: "delete",
      path: args.path,
      exists: false,
      type: "unknown",
    };
  }

  let isDir = false;
  let size = 0;
  try {
    const s = await workspace.fs.stat(rel);
    isDir = s.isDirectory;
    size = s.size;
  } catch {
    return {
      kind: "delete",
      path: args.path,
      exists: true,
      type: "unknown",
    };
  }

  if (isDir) {
    let childCount = 0;
    let totalBytes = 0;
    try {
      const entries = await workspace.fs.list(rel, { recursive: true });
      childCount = entries.length;
      // Cap how many entries we account for so the byte sum stays
      // bounded for huge trees; the cap matches `Math.min(...)` below
      // so the displayed `+N` and the size add up.
      const limit = Math.min(entries.length, CHILD_COUNT_CAP);
      for (let i = 0; i < limit; i++) {
        totalBytes += entries[i].size;
      }
    } catch {
      // Best-effort — keep partial counts.
    }
    return {
      kind: "delete",
      path: args.path,
      exists: true,
      type: "dir",
      sizeBytes: totalBytes,
      childCount: Math.min(childCount, CHILD_COUNT_CAP),
    };
  }

  const headPreview = await readHead(workspace, rel);
  return {
    kind: "delete",
    path: args.path,
    exists: true,
    type: "file",
    sizeBytes: size,
    headPreview,
  };
}

async function readHead(
  workspace: Workspace,
  rel: string,
): Promise<string[] | undefined> {
  try {
    const raw = await workspace.fs.readFile(rel, { encoding: "binary" });
    const buf =
      typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    if (looksBinary(buf)) return undefined;

    const truncated = buf.subarray(0, HEAD_BYTES_MAX);
    const text = truncated.toString("utf8");
    const lines = text.split("\n").slice(0, HEAD_LINES_MAX);
    return lines;
  } catch {
    return undefined;
  }
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, HEAD_BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function resolveRel(p: string, workspace: Workspace): Promise<string> {
  if (path.isAbsolute(p)) {
    return workspace.fs.toRelative(p);
  }
  return p;
}
