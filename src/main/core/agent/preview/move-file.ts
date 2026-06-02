/**
 * moveFile 预览生成器。校验 source/destination 解析后位于工作区内部,
 * 并呈现此次移动的结构特征:source 是否存在、它是文件还是目录,
 * 以及 destination 是否已被占用(覆盖风险)。
 */

import path from "node:path";
import type { Workspace } from "../../workspace/types";
import type { MoveFilePreview } from "./types";

interface MoveFileArgs {
  source: string;
  destination: string;
}

export async function computeMoveFilePreview(
  args: MoveFileArgs,
  workspace: Workspace,
): Promise<MoveFilePreview> {
  const srcRel = await resolveRel(args.source, workspace);
  const dstRel = await resolveRel(args.destination, workspace);

  const [sourceExists, destinationExists, sourceType] = await Promise.all([
    workspace.fs.exists(srcRel).catch(() => false),
    workspace.fs.exists(dstRel).catch(() => false),
    inspectKind(workspace, srcRel),
  ]);

  return {
    kind: "move",
    source: args.source,
    destination: args.destination,
    sourceExists,
    sourceType,
    destinationExists,
  };
}

async function resolveRel(p: string, workspace: Workspace): Promise<string> {
  if (path.isAbsolute(p)) {
    return workspace.fs.toRelative(p);
  }
  return p;
}

async function inspectKind(
  workspace: Workspace,
  rel: string,
): Promise<"file" | "dir" | "unknown"> {
  try {
    const s = await workspace.fs.stat(rel);
    return s.isDirectory ? "dir" : "file";
  } catch {
    return "unknown";
  }
}
