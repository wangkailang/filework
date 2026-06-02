/**
 * 分支级别的 diff 数据形态 —— 右侧抽屉用它来展示
 * 当前分支相对其基线(默认 `main`)累积的变更。该数据模型
 * 刻意复用 codex 风格的逐工具预览中的 {@link PreviewDiffHunk},
 * 这样渲染器就能让逐工具审批卡片和聚合抽屉都经由
 * 同一个 {@link DiffHunkView} 渲染。
 *
 * 纯 JSON;经由 `ipcRenderer.invoke("git:getBranchDiff", …)` 传输。
 */

import type { PreviewDiffHunk } from "../agent/preview/types";

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitFileDiff {
  /** 重命名后的路径;对于新增/修改/删除,这就是规范路径。 */
  path: string;
  /** 仅在重命名时设置;之前的路径。 */
  oldPath?: string;
  status: GitFileStatus;
  added: number;
  removed: number;
  isBinary: boolean;
  /** 二进制或被截断时为空。 */
  hunks: PreviewDiffHunk[];
  /** 逐文件截断:hunk 过多或单个 hunk 过大。 */
  truncated?: boolean;
}

export type BranchDiffNotAvailable =
  | "not-git"
  | "no-base"
  | "exec-failed"
  | "no-head";

export interface BranchDiff {
  /** 用于计算 diff 的 merge-base 的短 SHA。 */
  base: string;
  /** 面向用户的基线标签 —— 当远程 ref 可达时为 `"origin/main"`,
   *  否则为纯本地分支名。 */
  baseRef?: string;
  baseBranch: string;
  head: string;
  headBranch: string;
  files: GitFileDiff[];
  totalAdded: number;
  totalRemoved: number;
  /** 位于 HEAD 但不在 `origin/<currentBranch>` 上的提交(即
   *  未推送)。当本地分支没有上游时为 undefined。 */
  ahead?: number;
  /** 位于 `origin/<currentBranch>` 但不在 HEAD 上的提交(需拉取)。 */
  behind?: number;
  /** 存在已暂存 / 未暂存 / 未跟踪变更的文件(git status
   *  --porcelain;被 .gitignore 忽略的路径由 porcelain 自身排除)。 */
  uncommitted?: number;
  /** 当结果被设上限时为 true(>200 个文件或聚合体积过大)。 */
  truncated?: boolean;
  /** 当无法生成 diff 时设置。UI 会展示相应的空状态。 */
  notAvailable?: BranchDiffNotAvailable;
  /** 自由文本原因 —— 透传 git stderr 或抛出的错误信息。 */
  errorMessage?: string;
}
