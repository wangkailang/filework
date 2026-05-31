/**
 * Aggregate one assistant turn's tool parts into a `TurnSummaryPart` — the
 * machine-generated deliverable shown at the end of a turn. Pure function:
 * it reads facts the backend already attached to each tool result
 * (writeFile `diffStat`, runCommand `commandKind` / `testStats` / `exitCode`)
 * and never re-parses or re-diffs. Returns null when nothing was changed or
 * run, so pure Q&A turns render no card.
 *
 * See `core/session/message-parts.ts` for the shapes and the rationale.
 */

import type {
  MessagePart,
  ToolPart,
  TurnSummaryCommand,
  TurnSummaryFile,
  TurnSummaryPart,
} from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

interface DiffStat {
  added: number;
  removed: number;
  isNew: boolean;
  isBinary: boolean;
  truncated: boolean;
}

function readDiffStat(result: unknown): DiffStat | null {
  if (!isRecord(result) || !isRecord(result.diffStat)) return null;
  const d = result.diffStat;
  if (typeof d.added !== "number" || typeof d.removed !== "number") return null;
  return {
    added: d.added,
    removed: d.removed,
    isNew: d.isNew === true,
    isBinary: d.isBinary === true,
    truncated: d.truncated === true,
  };
}

function argPath(args: unknown): string | null {
  if (isRecord(args) && typeof args.path === "string") return args.path;
  return null;
}

/**
 * A mutating tool "took effect" only if it didn't fail. Covers both the
 * `output-error` state and the user-interrupt path, where a pending write
 * is normalized to `output-available` but carries `{ success: false,
 * cancelled: true }` — that file was never actually changed.
 */
function tookEffect(t: ToolPart): boolean {
  if (t.state === "output-error") return false;
  if (isRecord(t.result) && t.result.success === false) return false;
  return true;
}

function collectFiles(toolParts: ToolPart[]): TurnSummaryFile[] {
  // Insertion order preserved so the list reads in the order work happened.
  const byPath = new Map<string, TurnSummaryFile>();

  for (const t of toolParts) {
    if (t.toolName === "writeFile") {
      // A failed/cancelled write didn't change the file — skip it entirely.
      if (!tookEffect(t)) continue;
      const path = argPath(t.args);
      if (!path) continue;
      const ds = readDiffStat(t.result);
      const unknown = ds == null || ds.isBinary || ds.truncated;
      const existing = byPath.get(path);
      if (existing) {
        existing.writeCount += 1;
        existing.added += ds?.added ?? 0;
        existing.removed += ds?.removed ?? 0;
        if (unknown) existing.unknownStat = true;
        // op stays as the first write decided (create vs modify); a delete
        // later in the turn overrides it below.
        continue;
      }
      byPath.set(path, {
        path,
        op: ds?.isNew ? "create" : "modify",
        added: ds?.added ?? 0,
        removed: ds?.removed ?? 0,
        writeCount: 1,
        ...(unknown ? { unknownStat: true } : {}),
      });
    } else if (t.toolName === "deleteFile") {
      if (!tookEffect(t)) continue;
      const path = argPath(t.args);
      if (!path) continue;
      const existing = byPath.get(path);
      if (existing) {
        // Net effect of create-then-delete (or edit-then-delete) is a delete.
        existing.op = "delete";
        existing.added = 0;
        existing.removed = 0;
        existing.unknownStat = undefined;
      } else {
        byPath.set(path, {
          path,
          op: "delete",
          added: 0,
          removed: 0,
          writeCount: 1,
        });
      }
    }
  }

  return [...byPath.values()];
}

function collectCommands(toolParts: ToolPart[]): TurnSummaryCommand[] {
  const out: TurnSummaryCommand[] = [];
  for (const t of toolParts) {
    if (t.toolName !== "runCommand") continue;
    const command =
      isRecord(t.args) && typeof t.args.command === "string"
        ? t.args.command
        : "";
    if (!command) continue;
    const r = isRecord(t.result) ? t.result : {};
    const exitCode = typeof r.exitCode === "number" ? r.exitCode : null;
    const kind =
      r.commandKind === "test" || r.commandKind === "build"
        ? r.commandKind
        : "generic";
    // Only genuine deliverables belong in the card. Tests/builds are kept as
    // a verification signal; generic commands only if they changed the
    // filesystem (`deliverable`). Read-only inspections (du, find | while ...
    // stat, compute scripts) are scaffolding, not deliverables — they're hidden.
    if (kind === "generic" && r.deliverable !== true) continue;
    const entry: TurnSummaryCommand = { command, exitCode, kind };
    if (
      kind === "test" &&
      isRecord(r.testStats) &&
      typeof r.testStats.passed === "number" &&
      typeof r.testStats.failed === "number"
    ) {
      entry.testStats = {
        passed: r.testStats.passed,
        failed: r.testStats.failed,
      };
    }
    out.push(entry);
  }
  return out;
}

export function buildTurnSummary(parts: MessagePart[]): TurnSummaryPart | null {
  const toolParts = parts.filter((p): p is ToolPart => p.type === "tool");
  if (toolParts.length === 0) return null;

  const files = collectFiles(toolParts);
  const commands = collectCommands(toolParts);

  if (files.length === 0 && commands.length === 0) return null;
  return { type: "turn-summary", files, commands };
}
