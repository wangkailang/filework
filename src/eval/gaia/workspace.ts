/**
 * GAIA harness 的单题工作区初始化。
 *
 * 对每道题我们会:
 *   1. 创建一个全新的临时目录 `<outputDir>/workspaces/<taskId>/`
 *   2. 将附件(如有)从数据集目录复制进去
 *   3. 返回一个绑定到该目录的 `LocalWorkspace`,使 agent 的文件系统
 *      工具把相对路径解析到这个沙箱化的临时目录内
 *   4. 提供一个 `cleanup()` 回调,在 runner 用完后删除该工作区
 *
 * 为何用单题目录而非共享一个临时目录:
 *   - `LocalWorkspace` 的符号链接 / realpath 沙箱会拒绝越界访问,
 *     但按任务隔离让调试更容易(`workspaces/<id>/` 中*恰好*包含
 *     agent 所见的内容,含它创建的任何文件)
 *   - 让我们能在失败时保留工作区以供检查,而不会与无关任务堆在一起。
 */

import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { LocalWorkspace } from "../../main/core/workspace/local-workspace";

import type { NormalizedQuestion } from "./types";

export interface EvalWorkspace {
  workspace: LocalWorkspace;
  /** 单题目录的绝对路径。 */
  dir: string;
  /** 复制后附件的绝对路径,无附件时为 `null`。 */
  attachmentPath: string | null;
  /** 删除单题目录。可安全地多次调用。 */
  cleanup: () => Promise<void>;
}

export interface SetupOptions {
  question: NormalizedQuestion;
  /** 数据集根目录 —— `attachments` 相对于它解析。 */
  datasetDir: string;
  /** 输出根目录 —— 工作区位于 `<outputDir>/workspaces/<taskId>/` 下。 */
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
