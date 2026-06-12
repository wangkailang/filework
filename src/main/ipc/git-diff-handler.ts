/**
 * IPC: git:getBranchDiff — 聚合当前分支与其基线（默认 `main`）之间的
 * 差异。用于驱动右侧抽屉。
 *
 * 策略:
 *  1. 确认工作区是一个 git 工作树。
 *  2. 解析 HEAD 相对 baseBranch 的 merge-base。
 *  3. 针对 merge-base 运行 `git diff --no-color -U3 <base>` 和
 *     `--name-status`。单参数形式（无 `...HEAD`）会将基线提交与
 *     **工作树** 对比,因此同时包含分支提交和未提交（已暂存 + 未暂存）
 *     的改动 —— 这正是用户所说的"我的分支上改了什么"的本意。
 *  4. 用 `diff` npm 包的 `parsePatch` 解析,映射为 BranchDiff。
 *
 * 上限与 codex-preview 生成器保持一致: 总计 ≤200 个文件,每个文件
 * ≤200 个 hunk,每个 hunk 文本 ≤64 KB,每个文件 diff 总计 ≤1 MB。
 */

import { parsePatch } from "diff";
import { ipcMain } from "electron";
import type { PreviewDiffHunk } from "../core/agent/preview/types";
import type {
  BranchDiff,
  BranchDiffNotAvailable,
  GitFileDiff,
  GitFileStatus,
} from "../core/git-diff/types";
import { runGit } from "../core/workspace/clone-cache";

const MAX_FILES = 200;
const MAX_HUNKS_PER_FILE = 200;
const MAX_HUNK_BYTES = 64 * 1024;
const MAX_FILE_DIFF_BYTES = 1 * 1024 * 1024;

interface GetBranchDiffArgs {
  path: string;
  baseBranch?: string;
}

export const registerGitDiffHandlers = (): void => {
  ipcMain.handle(
    "git:getBranchDiff",
    async (_event, payload: GetBranchDiffArgs): Promise<BranchDiff> => {
      const cwd = payload.path;
      const baseBranch = payload.baseBranch ?? "main";
      try {
        return await computeBranchDiff(cwd, baseBranch);
      } catch (err) {
        return makeNotAvailable(
          "exec-failed",
          baseBranch,
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
};

async function computeBranchDiff(
  cwd: string,
  baseBranch: string,
): Promise<BranchDiff> {
  const probe = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    return makeNotAvailable("not-git", baseBranch, probe.stderr.trim());
  }

  const headRev = await runGit(["rev-parse", "HEAD"], { cwd });
  if (headRev.exitCode !== 0) {
    return makeNotAvailable("no-head", baseBranch, headRev.stderr.trim());
  }
  const head = headRev.stdout.trim().slice(0, 12);

  const headBranchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
  });
  // 在游离 HEAD 状态下 `--abbrev-ref` 返回字面量 "HEAD"（exit 0）。
  // 用短 SHA 替换,避免抽屉显示成 "HEAD vs main"。
  const rawBranch =
    headBranchRes.exitCode === 0 ? headBranchRes.stdout.trim() : "";
  const headBranch = !rawBranch || rawBranch === "HEAD" ? head : rawBranch;

  // 优先使用远程跟踪 ref,使 diff 与针对 `<baseBranch>` 的 PR 所展示
  // 的内容一致。当未配置 origin 时（例如全新 `git init`）回退到本地分支。
  const remoteRef = `origin/${baseBranch}`;
  const remoteProbe = await runGit(
    ["rev-parse", "--verify", "--quiet", remoteRef],
    { cwd },
  );
  const baseRef = remoteProbe.exitCode === 0 ? remoteRef : baseBranch;

  const mergeBase = await runGit(["merge-base", baseRef, "HEAD"], { cwd });
  if (mergeBase.exitCode !== 0) {
    return makeNotAvailable("no-base", baseBranch, mergeBase.stderr.trim());
  }
  const base = mergeBase.stdout.trim().slice(0, 12);
  const baseFull = mergeBase.stdout.trim();

  // 状态徽标。全部尽力而为 —— 即使其中任一 git 调用失败,handler
  // 仍返回可用的 BranchDiff。
  const [aheadBehind, uncommitted] = await Promise.all([
    collectAheadBehind(cwd, headBranch),
    collectUncommitted(cwd),
  ]);

  // --name-status 驱动重命名检测（R100  oldPath\tnewPath）。
  // 单参数形式（无 `...HEAD`）对比 base → 工作树。
  const nameStatus = await runGit(
    ["diff", "--no-color", "--name-status", "--find-renames", baseFull],
    { cwd },
  );
  // 容忍 --name-status 失败,仅解析有效的 stdout —— 重命名会退化为
  // 增 + 删配对,但主 diff 仍正常产出。
  const statusByPath =
    nameStatus.exitCode === 0
      ? parseNameStatus(nameStatus.stdout)
      : new Map<string, NameStatusEntry>();

  const diffRes = await runGit(
    ["diff", "--no-color", "-U3", "--find-renames", baseFull],
    { cwd },
  );
  if (diffRes.exitCode !== 0) {
    return makeNotAvailable("exec-failed", baseBranch, diffRes.stderr.trim());
  }

  const parsed = parsePatch(diffRes.stdout);
  const files: GitFileDiff[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let truncated = false;

  for (const p of parsed) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    let file: GitFileDiff | null;
    try {
      file = mapToFileDiff(p, statusByPath);
    } catch (err) {
      console.warn(
        "[git-diff] skipping malformed parsePatch entry:",
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!file) continue;
    totalAdded += file.added;
    totalRemoved += file.removed;
    files.push(file);
  }

  // 将未跟踪文件作为合成的 "added" diff 追加。已跟踪文件优先占用
  // MAX_FILES 名额,这样嘈杂的未跟踪区域（例如被 gitignore 遗漏的
  // 缓存目录）不会挤掉真实改动。
  if (!truncated) {
    const untracked = await collectUntrackedDiffs(
      cwd,
      MAX_FILES - files.length,
    );
    for (const f of untracked.diffs) {
      totalAdded += f.added;
      totalRemoved += f.removed;
      files.push(f);
    }
    if (untracked.truncated) truncated = true;
  }

  return {
    base,
    baseRef,
    baseBranch,
    head,
    headBranch,
    files,
    totalAdded,
    totalRemoved,
    ...(aheadBehind.ahead !== undefined ? { ahead: aheadBehind.ahead } : {}),
    ...(aheadBehind.behind !== undefined ? { behind: aheadBehind.behind } : {}),
    ...(uncommitted !== undefined ? { uncommitted } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

interface AheadBehind {
  ahead?: number;
  behind?: number;
}

async function collectAheadBehind(
  cwd: string,
  headBranch: string,
): Promise<AheadBehind> {
  // 游离 HEAD / 无上游 → 静默跳过徽标。
  if (!headBranch || headBranch === "HEAD" || /^[0-9a-f]+$/.test(headBranch)) {
    return {};
  }
  const upstream = `origin/${headBranch}`;
  const probe = await runGit(["rev-parse", "--verify", "--quiet", upstream], {
    cwd,
  });
  if (probe.exitCode !== 0) {
    // 分支尚未推送 —— 此处返回 0 会暗示"全部已推送",故留作 undefined。
    return {};
  }
  const res = await runGit(
    ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
    { cwd },
  );
  if (res.exitCode !== 0) return {};
  // 格式: "<behind>\t<ahead>"（左侧为上游,右侧为 HEAD）。
  const [behindStr, aheadStr] = res.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindStr ?? "", 10);
  const ahead = Number.parseInt(aheadStr ?? "", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : undefined,
    behind: Number.isFinite(behind) ? behind : undefined,
  };
}

async function collectUncommitted(cwd: string): Promise<number | undefined> {
  // `-uall` 会展开未跟踪目录,使每个文件各占一行 `??`。否则像
  // `src/games/NinjaRun/` 这样的未跟踪目录会折叠成单行,徽标会显示
  // `1`,而抽屉（通过 ls-files）却会独立列出每个文件。这样可让计数
  // 与抽屉保持同步。
  const res = await runGit(["status", "--porcelain", "-uall"], { cwd });
  if (res.exitCode !== 0) return undefined;
  if (!res.stdout) return 0;
  return res.stdout.split("\n").filter((l) => l.length > 0).length;
}

/**
 * 收集未跟踪文件（按 .gitignore 过滤）,并通过运行
 * `git diff --no-index /dev/null <path>` 为每个文件合成一个 GitFileDiff。
 *
 * 原因: `git diff <merge-base>` 只能看到已跟踪内容,因此像
 * `src/games/NinjaRun/*` 这样的新功能在首次 `git add` 之前对分支
 * diff 面板不可见。此辅助函数弥补了这一缺口。
 *
 * 上限: 接收 `capRemaining`（MAX_FILES 尚未消耗的名额）,使合并后的
 * 列表保持在全局上限之下。`git diff --no-index` 在（正常的）"文件存在
 * 差异"情况下返回退出码 1 —— 我们明确地容忍它。二进制 blob 会表现为
 * 空 hunk 的 ParsedFile,由 `mapToFileDiff` 的 `isBinary` 检测处理。
 */
async function collectUntrackedDiffs(
  cwd: string,
  capRemaining: number,
): Promise<{ diffs: GitFileDiff[]; truncated: boolean }> {
  if (capRemaining <= 0) return { diffs: [], truncated: false };
  // `-z` ⇒ 以 NUL 分隔路径,对空格 / unicode / 引号都更健壮。
  // `-c core.quotePath=false` 使非 ASCII 路径（例如 `naïve.txt`）保持
  // 为可读的 UTF-8,而非 `na\303\257ve.txt` 这样的转义序列,使抽屉中
  // 的文件名与用户在磁盘上看到的一致。
  const ls = await runGit(
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd },
  );
  if (ls.exitCode !== 0) return { diffs: [], truncated: false };
  const paths = ls.stdout.split("\0").filter((p) => p.length > 0);

  const diffs: GitFileDiff[] = [];
  let truncated = false;
  for (const p of paths) {
    if (diffs.length >= capRemaining) {
      truncated = true;
      break;
    }
    const res = await runGit(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-index",
        "--no-color",
        "-U3",
        "--",
        "/dev/null",
        p,
      ],
      { cwd },
    );
    // 0 字节文件与 /dev/null 逐字节相同,因此 `git diff --no-index`
    // 会以空 stdout 退出码 0 返回。若不合成条目,该文件会从面板消失
    // —— `touch foo.tsx` 将不可见。将其渲染为空的 "added" 文件,使
    // 用户至少能看到路径。
    if (res.exitCode === 0 && !res.stdout) {
      diffs.push({
        path: p,
        status: "added",
        added: 0,
        removed: 0,
        isBinary: false,
        hunks: [],
      });
      continue;
    }
    // 相对 /dev/null 时,退出码 0 却带非空 stdout 本不应发生,但仍容忍;
    // 退出码 1 = 存在差异（预期的正常情况）;其他任何值 = 真实错误,
    // 跳过此文件但继续处理。
    if (res.exitCode !== 0 && res.exitCode !== 1) continue;
    if (!res.stdout) continue;

    for (const parsedEntry of parsePatch(res.stdout)) {
      let file: GitFileDiff | null;
      try {
        file = mapToFileDiff(parsedEntry, new Map());
      } catch (err) {
        console.warn(
          "[git-diff] skipping malformed untracked patch:",
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      if (!file) continue;
      // 强制 status 为 "added": 相对 /dev/null 的 --no-index 已通过
      // mapToFileDiff 第 268 行分支得出此结果,但仍固定下来,以防
      // 未来对该逻辑的改动悄悄翻转标签。
      file.status = "added";
      diffs.push(file);
    }
  }
  return { diffs, truncated };
}

interface NameStatusEntry {
  status: GitFileStatus;
  oldPath?: string;
}

function parseNameStatus(stdout: string): Map<string, NameStatusEntry> {
  const out = new Map<string, NameStatusEntry>();
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    const parts = rawLine.split("\t");
    const code = parts[0]?.[0] ?? "";
    if (code === "A" && parts[1]) {
      out.set(parts[1], { status: "added" });
    } else if (code === "M" && parts[1]) {
      out.set(parts[1], { status: "modified" });
    } else if (code === "D" && parts[1]) {
      out.set(parts[1], { status: "deleted" });
    } else if (code === "R" && parts[1] && parts[2]) {
      out.set(parts[2], { status: "renamed", oldPath: parts[1] });
    } else if (code === "C" && parts[1] && parts[2]) {
      out.set(parts[2], { status: "added" });
    }
  }
  return out;
}

type ParsedFile = ReturnType<typeof parsePatch>[number];

function mapToFileDiff(
  parsed: ParsedFile,
  statusByPath: Map<string, NameStatusEntry>,
): GitFileDiff | null {
  const newPath = stripABPrefix(parsed.newFileName);
  const oldPath = stripABPrefix(parsed.oldFileName);
  if (!newPath && !oldPath) return null;

  const canonicalPath =
    newPath && newPath !== "/dev/null" ? newPath : (oldPath ?? "unknown");
  const entry = statusByPath.get(canonicalPath);
  let status: GitFileStatus;
  let renamedFrom: string | undefined;
  if (entry) {
    status = entry.status;
    renamedFrom = entry.oldPath;
  } else if (newPath === "/dev/null") {
    status = "deleted";
  } else if (oldPath === "/dev/null") {
    status = "added";
  } else if (oldPath && newPath && oldPath !== newPath) {
    status = "renamed";
    renamedFrom = oldPath;
  } else {
    status = "modified";
  }

  let added = 0;
  let removed = 0;
  let truncated = false;
  const hunks: PreviewDiffHunk[] = [];
  let totalBytes = 0;

  const parsedHunks = parsed.hunks ?? [];
  for (const h of parsedHunks) {
    if (hunks.length >= MAX_HUNKS_PER_FILE) {
      truncated = true;
      break;
    }
    if (totalBytes > MAX_FILE_DIFF_BYTES) {
      truncated = true;
      break;
    }
    const headerLine = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    hunks.push({
      kind: "context",
      value: `${headerLine}\n`,
      lineCount: 1,
    });
    const runs = groupHunkLines(h.lines, h.oldStart, h.newStart);
    for (const run of runs) {
      const value = `${run.lines.join("\n")}\n`;
      const bytes = Buffer.byteLength(value, "utf8");
      const overSized = bytes > MAX_HUNK_BYTES;
      // 当 run 被切片后,我们就无法统计每一行 —— 渲染文本只包含开头
      // 的字节。将保留行数估算为
      // `value.slice(0, MAX_HUNK_BYTES).split("\n").length`。
      const slicedValue = overSized ? sliceUtf8(value, MAX_HUNK_BYTES) : value;
      const keptLineCount = overSized
        ? Math.max(0, slicedValue.split("\n").length - 2) // 减去 "…\n" 哨兵
        : run.lines.length;
      totalBytes += overSized ? MAX_HUNK_BYTES : bytes;
      if (run.kind === "added") added += keptLineCount;
      else if (run.kind === "removed") removed += keptLineCount;
      hunks.push({
        kind: run.kind,
        value: slicedValue,
        lineCount: keptLineCount,
        ...(run.oldStart !== undefined ? { oldStart: run.oldStart } : {}),
        ...(run.newStart !== undefined ? { newStart: run.newStart } : {}),
      });
      if (overSized) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  // 对于二进制 blob,`git diff` 会输出 `Binary files X and Y differ`,
  // parsePatch 将其表现为带有效文件名但 `hunks` 数组为空的 ParsedFile。
  // 纯重命名（无内容变更）同样有空 hunk,但它们带有来自 --name-status
  // 的重命名状态。其余 hunk 数为零的情况即视为二进制。
  const isBinary =
    hunks.length === 0 && status !== "renamed" && parsedHunks.length === 0;

  return {
    path: canonicalPath,
    ...(renamedFrom ? { oldPath: renamedFrom } : {}),
    status,
    added,
    removed,
    isBinary,
    hunks,
    ...(truncated ? { truncated: true } : {}),
  };
}

interface HunkRun {
  kind: PreviewDiffHunk["kind"];
  lines: string[];
  oldStart?: number;
  newStart?: number;
}

function groupHunkLines(
  rawLines: string[],
  oldStart: number,
  newStart: number,
): HunkRun[] {
  const runs: HunkRun[] = [];
  let current: HunkRun | null = null;
  let oldLine = oldStart;
  let newLine = newStart;
  for (const raw of rawLines) {
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"（文件末尾无换行符）
    const prefix = raw[0];
    const content = raw.length > 0 ? raw.slice(1) : "";
    const kind: PreviewDiffHunk["kind"] =
      prefix === "+" ? "added" : prefix === "-" ? "removed" : "context";
    if (!current || current.kind !== kind) {
      current = {
        kind,
        lines: [],
        ...(kind !== "added" ? { oldStart: oldLine } : {}),
        ...(kind !== "removed" ? { newStart: newLine } : {}),
      };
      runs.push(current);
    }
    current.lines.push(content);
    if (kind !== "added") oldLine++;
    if (kind !== "removed") newLine++;
  }
  return runs;
}

function stripABPrefix(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (name === "/dev/null") return name;
  if (name.startsWith("a/")) return name.slice(2);
  if (name.startsWith("b/")) return name.slice(2);
  return name;
}

function sliceUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  return `${buf.subarray(0, maxBytes).toString("utf8")}\n…\n`;
}

function makeNotAvailable(
  reason: BranchDiffNotAvailable,
  baseBranch: string,
  errorMessage: string,
): BranchDiff {
  return {
    base: "",
    baseBranch,
    head: "",
    headBranch: "",
    files: [],
    totalAdded: 0,
    totalRemoved: 0,
    notAvailable: reason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}
