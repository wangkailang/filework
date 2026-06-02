/**
 * 工具预览的数据结构 —— 即审批卡片在破坏性工具运行前所渲染的内容。
 * 由主进程的预览生成器(见 `./index.ts`)在审批阶段生成,以纯 JSON
 * 形式通过 `ai:stream-tool-batch-approval` 的 IPC 负载传输,并由渲染
 * 进程的预览卡片消费。
 *
 * 所有结构必须保持可 JSON 序列化:不含函数、类、Date 或 buffer。
 * IPC 桥接与 JSONL 持久化都依赖这一点。
 */

export interface PreviewDiffHunk {
  kind: "added" | "removed" | "context";
  /**
   * 原始变更文本(含末尾换行),与 `diff` npm 包 `diffLines()` 返回的
   * `Change.value` 结构保持一致。
   */
  value: string;
  lineCount: number;
}

export interface WriteFilePreview {
  kind: "write";
  path: string;
  action: "create" | "overwrite";
  oldExists: boolean;
  isBinary: boolean;
  oldLines: number;
  newLines: number;
  added: number;
  removed: number;
  /** 当为二进制或被截断时为空。 */
  hunks: PreviewDiffHunk[];
  truncated?: "oldTooLarge" | "newTooLarge" | "diffTooLarge";
  /** sha1(oldRaw) —— 让执行器能检测到审批与实际应用之间发生的外部修改。 */
  oldHash?: string;
}

export interface MoveFilePreview {
  kind: "move";
  source: string;
  destination: string;
  sourceExists: boolean;
  sourceType: "file" | "dir" | "unknown";
  destinationExists: boolean;
}

export interface DeleteFilePreview {
  kind: "delete";
  path: string;
  exists: boolean;
  type: "file" | "dir" | "unknown";
  sizeBytes?: number;
  /** 仅目录适用。上限为 5000 —— 超出部分渲染为 "5000+"。 */
  childCount?: number;
  /** 仅文本文件适用:取前 ≤20 行,总计 ≤2 KB。 */
  headPreview?: string[];
}

export interface CreateDirectoryPreview {
  kind: "mkdir";
  path: string;
  alreadyExists: boolean;
  parentExists: boolean;
}

export interface RunCommandPreview {
  kind: "run";
  command: string;
  cwd?: string;
  cwdExists: boolean;
}

export type ToolPreview =
  | WriteFilePreview
  | MoveFilePreview
  | DeleteFilePreview
  | CreateDirectoryPreview
  | RunCommandPreview;
