/**
 * deleteFile 预览生成器。在不删除目标的前提下检查它:
 * 对文件执行 stat,对目录执行递归列举(设有上限),并可选地
 * 提取头部文本片段,以便审批卡片能展示*将要*被删除的内容。
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
      // 限制纳入统计的条目数量,使字节总和在巨型目录树下保持有界;
      // 该上限与下方的 `Math.min(...)` 一致,
      // 因此显示的 `+N` 与体积能对得上。
      const limit = Math.min(entries.length, CHILD_COUNT_CAP);
      for (let i = 0; i < limit; i++) {
        totalBytes += entries[i].size;
      }
    } catch {
      // 尽力而为——保留部分计数。
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
