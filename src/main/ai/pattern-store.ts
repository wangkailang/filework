// Fire-and-forget JSONL capture sink. No-op until initPatternStore() is
// called. Writes serialize via a 1-deep promise chain so JSONL lines
// don't interleave under concurrent appends.

import { appendFile, readFile } from "node:fs/promises";
import type { TokenUsage } from "../core/agent/events";
import type { SubAgentStatus } from "../core/agent/sub-agent-contract";

export interface SubAgentPatternRecord {
  kind: "subagent";
  ts: string;
  agentId: string;
  contractGoal: string;
  status: SubAgentStatus;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
}

export interface TaskPatternRecord {
  kind: "task";
  ts: string;
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  totalUsage?: TokenUsage;
  durationMs: number;
}

export type PatternRecord = SubAgentPatternRecord | TaskPatternRecord;

let storePath: string | undefined;

/** Serialization chain — every appendPattern() chains on the previous write. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Configure the JSONL file path. Production: call once at app startup
 * with `join(app.getPath("userData"), "patterns.jsonl")`. Tests: pass a
 * tmpdir path.
 */
export function initPatternStore(absolutePath: string): void {
  storePath = absolutePath;
}

export function getPatternStorePath(): string | undefined {
  return storePath;
}

/** Reset for tests. */
export function __resetPatternStoreForTests(): void {
  storePath = undefined;
  writeChain = Promise.resolve();
}

/**
 * Fire-and-forget append. Returns the write promise so tests can await
 * — production callers ignore the return value.
 */
export function appendPattern(record: PatternRecord): Promise<void> {
  if (!storePath) return Promise.resolve();
  const line = `${JSON.stringify(record)}\n`;
  const target = storePath;
  writeChain = writeChain
    .catch((err) => {
      console.warn(
        "[PatternStore] prior write failed (chain head):",
        err instanceof Error ? err.message : err,
      );
    })
    .then(() =>
      appendFile(target, line, "utf-8").catch((err) => {
        console.warn(
          "[PatternStore] append failed:",
          err instanceof Error ? err.message : err,
        );
      }),
    );
  return writeChain;
}

/** Test helper — read & parse all records. */
export async function readAllPatterns(): Promise<PatternRecord[]> {
  if (!storePath) return [];
  try {
    const raw = await readFile(storePath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as PatternRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
