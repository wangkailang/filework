/**
 * writeFile 预览生成器。通过 workspace FS 读取现有文件内容,
 * 与新内容做行级 diff,返回可序列化的 `WriteFilePreview`。
 * 算法与渲染端的 `useWriteDiff` 保持一致,使审批卡片所展示的内容
 * 与应用后工具输出卡片展示的内容相符。
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { diffLines } from "diff";
import type { Workspace } from "../../workspace/types";
import type { PreviewDiffHunk, WriteFilePreview } from "./types";

/** 单侧上限。旧内容或新内容任一超过此值 → 不生成 diff 主体。 */
const MAX_FILE_BYTES = 1 * 1024 * 1024;
/** 嗅探多少字节以检测 NUL 字节,从而判断是否为二进制内容。 */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** diff 输出超过该 hunk 数量后进行截断。 */
const MAX_HUNKS = 200;
/** 单个 hunk 文本超过该字节数后进行截断。 */
const MAX_HUNK_BYTES = 64 * 1024;

interface WriteFileArgs {
  path: string;
  content: string;
}

export async function computeWriteFilePreview(
  args: WriteFileArgs,
  workspace: Workspace,
): Promise<WriteFilePreview> {
  const rel = await resolveRel(args.path, workspace);
  const newContent = args.content;
  const newLines = countLines(newContent);
  const newSize = Buffer.byteLength(newContent, "utf8");

  const existed = await workspace.fs.exists(rel).catch(() => false);

  if (!existed) {
    const isBinaryNew = sniffBinary(Buffer.from(newContent, "utf8"));
    if (isBinaryNew || newSize > MAX_FILE_BYTES) {
      return {
        kind: "write",
        path: args.path,
        action: "create",
        oldExists: false,
        isBinary: isBinaryNew,
        oldLines: 0,
        newLines,
        added: 0,
        removed: 0,
        hunks: [],
        truncated: isBinaryNew ? undefined : "newTooLarge",
      };
    }
    return {
      kind: "write",
      path: args.path,
      action: "create",
      oldExists: false,
      isBinary: false,
      oldLines: 0,
      newLines,
      added: newLines,
      removed: 0,
      hunks: [
        {
          kind: "added",
          value: newContent,
          lineCount: newLines,
        },
      ],
    };
  }

  let oldSize: number;
  try {
    const s = await workspace.fs.stat(rel);
    oldSize = s.size;
  } catch {
    // stat 不可读 → 优雅降级,而非阻塞审批。
    return {
      kind: "write",
      path: args.path,
      action: "overwrite",
      oldExists: true,
      isBinary: false,
      oldLines: 0,
      newLines,
      added: 0,
      removed: 0,
      hunks: [],
      truncated: "oldTooLarge",
    };
  }

  let truncated: WriteFilePreview["truncated"];
  if (oldSize > MAX_FILE_BYTES) truncated = "oldTooLarge";
  if (newSize > MAX_FILE_BYTES) truncated ??= "newTooLarge";

  if (truncated) {
    return {
      kind: "write",
      path: args.path,
      action: "overwrite",
      oldExists: true,
      isBinary: false,
      oldLines: 0,
      newLines,
      added: 0,
      removed: 0,
      hunks: [],
      truncated,
    };
  }

  const oldRaw = await workspace.fs.readFile(rel, { encoding: "binary" });
  const oldBuf =
    typeof oldRaw === "string"
      ? Buffer.from(oldRaw, "utf8")
      : Buffer.from(oldRaw);

  const isBinary =
    sniffBinary(oldBuf) || sniffBinary(Buffer.from(newContent, "utf8"));
  if (isBinary) {
    return {
      kind: "write",
      path: args.path,
      action: "overwrite",
      oldExists: true,
      isBinary: true,
      oldLines: 0,
      newLines,
      added: 0,
      removed: 0,
      hunks: [],
    };
  }

  const oldText = oldBuf.toString("utf8");
  const oldLines = countLines(oldText);

  if (oldText === newContent) {
    return {
      kind: "write",
      path: args.path,
      action: "overwrite",
      oldExists: true,
      isBinary: false,
      oldLines,
      newLines,
      added: 0,
      removed: 0,
      hunks: [],
      oldHash: sha1(oldText),
    };
  }

  const changes = diffLines(oldText, newContent);

  let added = 0;
  let removed = 0;
  const hunks: PreviewDiffHunk[] = [];
  let diffTruncated = false;
  for (const c of changes) {
    const lineCount = c.count ?? countLines(c.value);
    const kind: PreviewDiffHunk["kind"] = c.added
      ? "added"
      : c.removed
        ? "removed"
        : "context";
    if (kind === "added") added += lineCount;
    else if (kind === "removed") removed += lineCount;

    if (hunks.length >= MAX_HUNKS) {
      diffTruncated = true;
      continue;
    }
    let value = c.value;
    if (Buffer.byteLength(value, "utf8") > MAX_HUNK_BYTES) {
      diffTruncated = true;
      value = sliceUtf8(value, MAX_HUNK_BYTES);
    }
    hunks.push({ kind, value, lineCount });
  }

  return {
    kind: "write",
    path: args.path,
    action: "overwrite",
    oldExists: true,
    isBinary: false,
    oldLines,
    newLines,
    added,
    removed,
    hunks,
    truncated: diffTruncated ? "diffTooLarge" : undefined,
    oldHash: sha1(oldText),
  };
}

async function resolveRel(p: string, workspace: Workspace): Promise<string> {
  if (path.isAbsolute(p)) {
    return workspace.fs.toRelative(p);
  }
  return p;
}

function countLines(s: string): number {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

function sniffBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function sliceUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  return `${buf.subarray(0, maxBytes).toString("utf8")}\n…\n`;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export const __testing = {
  countLines,
  sniffBinary,
  MAX_FILE_BYTES,
  MAX_HUNKS,
  MAX_HUNK_BYTES,
};
