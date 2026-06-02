/**
 * runCommand 预览生成器。原样呈现 command 与 cwd,并校验 cwd 解析后
 * 位于工作区内部。绝不执行该命令 —— 审批卡片只展示即将运行的内容。
 */

import path from "node:path";
import type { Workspace } from "../../workspace/types";
import type { RunCommandPreview } from "./types";

interface RunCommandArgs {
  command: string;
  cwd?: string;
}

export async function computeRunCommandPreview(
  args: RunCommandArgs,
  workspace: Workspace,
): Promise<RunCommandPreview> {
  const cwd = args.cwd;
  if (cwd === undefined || cwd === "") {
    return {
      kind: "run",
      command: args.command,
      cwdExists: true,
    };
  }
  let rel: string;
  try {
    rel = path.isAbsolute(cwd) ? await workspace.fs.toRelative(cwd) : cwd;
  } catch {
    return {
      kind: "run",
      command: args.command,
      cwd,
      cwdExists: false,
    };
  }
  const cwdExists = await workspace.fs.exists(rel).catch(() => false);
  return {
    kind: "run",
    command: args.command,
    cwd,
    cwdExists,
  };
}
