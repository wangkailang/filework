/**
 * runCommand preview generator. Surfaces the command + cwd verbatim and
 * verifies that the cwd resolves inside the workspace. Never executes
 * the command — the approval card just shows what would run.
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
