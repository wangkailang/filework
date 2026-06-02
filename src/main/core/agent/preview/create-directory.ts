/**
 * createDirectory 预览生成器。报告目标路径是否已存在(无操作的条件),
 * 以及父目录是否存在(递归 mkdir 是否会创建中间目录)。
 */

import path from "node:path";
import type { Workspace } from "../../workspace/types";
import type { CreateDirectoryPreview } from "./types";

interface CreateDirectoryArgs {
  path: string;
}

export async function computeCreateDirectoryPreview(
  args: CreateDirectoryArgs,
  workspace: Workspace,
): Promise<CreateDirectoryPreview> {
  const rel = await resolveRel(args.path, workspace);
  const alreadyExists = await workspace.fs.exists(rel).catch(() => false);
  const parentExists = await parentDirExists(workspace, rel);

  return {
    kind: "mkdir",
    path: args.path,
    alreadyExists,
    parentExists,
  };
}

async function parentDirExists(
  workspace: Workspace,
  rel: string,
): Promise<boolean> {
  const parent = path.posix.dirname(rel.split(path.sep).join("/"));
  if (parent === "" || parent === "." || parent === "/") return true;
  return workspace.fs.exists(parent).catch(() => false);
}

async function resolveRel(p: string, workspace: Workspace): Promise<string> {
  if (path.isAbsolute(p)) {
    return workspace.fs.toRelative(p);
  }
  return p;
}
