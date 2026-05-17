/**
 * Per-question workspace setup for the GAIA harness.
 *
 * For every question we:
 *   1. Create a fresh temporary directory `<outputDir>/workspaces/<taskId>/`
 *   2. Copy the attachment (if any) from the dataset directory into it
 *   3. Hand back a `LocalWorkspace` bound to that directory so the
 *      agent's filesystem tools resolve relative paths inside the
 *      sandboxed temp dir
 *   4. Provide a `cleanup()` callback that rm's the workspace when the
 *      runner is done with it
 *
 * Why per-question dirs instead of one shared temp:
 *   - Symlink / realpath sandboxing in `LocalWorkspace` rejects escapes,
 *     but isolating per-task makes debugging easier (`workspaces/<id>/`
 *     contains *exactly* what the agent saw, including any files it
 *     created)
 *   - Lets us keep the workspaces around on failure for inspection
 *     without piling up alongside unrelated tasks.
 */

import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { LocalWorkspace } from "../../main/core/workspace/local-workspace";

import type { NormalizedQuestion } from "./types";

export interface EvalWorkspace {
  workspace: LocalWorkspace;
  /** Absolute path to the per-question dir. */
  dir: string;
  /** Absolute path to the copied attachment, or `null` when none. */
  attachmentPath: string | null;
  /** Remove the per-question dir. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

export interface SetupOptions {
  question: NormalizedQuestion;
  /** Dataset root — `attachments` are resolved against this. */
  datasetDir: string;
  /** Output root — workspaces live under `<outputDir>/workspaces/<taskId>/`. */
  outputDir: string;
}

export const setupQuestionWorkspace = async (
  opts: SetupOptions,
): Promise<EvalWorkspace> => {
  const dir = path.join(opts.outputDir, "workspaces", opts.question.taskId);
  await mkdir(dir, { recursive: true });

  let attachmentPath: string | null = null;
  if (opts.question.fileName) {
    const source = path.join(opts.datasetDir, opts.question.fileName);
    const dest = path.join(dir, path.basename(opts.question.fileName));
    await copyFile(source, dest);
    attachmentPath = dest;
  }

  const workspace = new LocalWorkspace(dir, {
    id: `gaia-eval:${opts.question.taskId}`,
  });

  return {
    workspace,
    dir,
    attachmentPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};
