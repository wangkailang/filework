/**
 * IPC: git:getBranchDiff — aggregate diff between the current branch
 * and its base (default `main`). Powers the right-side drawer.
 *
 * Strategy:
 *  1. Confirm the workspace is a git working tree.
 *  2. Resolve merge-base of HEAD against baseBranch.
 *  3. Run `git diff --no-color -U3 <base>` and `--name-status` against
 *     the merge-base. The single-arg form (no `...HEAD`) compares the
 *     base commit to the **working tree**, so it includes both branch
 *     commits AND uncommitted (staged + unstaged) edits — what users
 *     actually mean by "what changed on my branch".
 *  4. Parse with `diff` npm pkg's `parsePatch`, map to BranchDiff.
 *
 * Caps mirror the codex-preview generators: ≤200 files total, ≤200
 * hunks per file, ≤64 KB per hunk text, ≤1 MB total per file diff.
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
  // `--abbrev-ref` returns literal "HEAD" on detached HEAD (exit 0).
  // Substitute the short SHA so the drawer doesn't read as "HEAD vs main".
  const rawBranch =
    headBranchRes.exitCode === 0 ? headBranchRes.stdout.trim() : "";
  const headBranch = !rawBranch || rawBranch === "HEAD" ? head : rawBranch;

  const mergeBase = await runGit(["merge-base", baseBranch, "HEAD"], { cwd });
  if (mergeBase.exitCode !== 0) {
    return makeNotAvailable("no-base", baseBranch, mergeBase.stderr.trim());
  }
  const base = mergeBase.stdout.trim().slice(0, 12);
  const baseFull = mergeBase.stdout.trim();

  // --name-status drives rename detection (R100  oldPath\tnewPath).
  // Single-arg form (no `...HEAD`) compares base → working tree.
  const nameStatus = await runGit(
    ["diff", "--no-color", "--name-status", "--find-renames", baseFull],
    { cwd },
  );
  // Tolerate a failed --name-status by parsing only valid stdout —
  // renames degrade to add+delete pairs but the main diff still ships.
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

  return {
    base,
    baseBranch,
    head,
    headBranch,
    files,
    totalAdded,
    totalRemoved,
    ...(truncated ? { truncated: true } : {}),
  };
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
    const runs = groupHunkLines(h.lines);
    for (const run of runs) {
      const value = `${run.lines.join("\n")}\n`;
      const bytes = Buffer.byteLength(value, "utf8");
      const overSized = bytes > MAX_HUNK_BYTES;
      // When the run gets sliced we can no longer count every line —
      // the rendered text only contains the leading bytes. Estimate
      // kept lines as `value.slice(0, MAX_HUNK_BYTES).split("\n").length`.
      const slicedValue = overSized
        ? sliceUtf8(value, MAX_HUNK_BYTES)
        : value;
      const keptLineCount = overSized
        ? Math.max(0, slicedValue.split("\n").length - 2) // minus the "…\n" sentinel
        : run.lines.length;
      totalBytes += overSized ? MAX_HUNK_BYTES : bytes;
      if (run.kind === "added") added += keptLineCount;
      else if (run.kind === "removed") removed += keptLineCount;
      hunks.push({
        kind: run.kind,
        value: slicedValue,
        lineCount: keptLineCount,
      });
      if (overSized) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return {
    path: canonicalPath,
    ...(renamedFrom ? { oldPath: renamedFrom } : {}),
    status,
    added,
    removed,
    isBinary: false,
    hunks,
    ...(truncated ? { truncated: true } : {}),
  };
}

interface HunkRun {
  kind: PreviewDiffHunk["kind"];
  lines: string[];
}

function groupHunkLines(rawLines: string[]): HunkRun[] {
  const runs: HunkRun[] = [];
  let current: HunkRun | null = null;
  for (const raw of rawLines) {
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const prefix = raw[0];
    const content = raw.length > 0 ? raw.slice(1) : "";
    const kind: PreviewDiffHunk["kind"] =
      prefix === "+" ? "added" : prefix === "-" ? "removed" : "context";
    if (!current || current.kind !== kind) {
      current = { kind, lines: [] };
      runs.push(current);
    }
    current.lines.push(content);
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
