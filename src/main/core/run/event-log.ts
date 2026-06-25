/**
 * JsonlRunEventLog —— 本地 append-only 的运行流事件日志。
 *
 * 语义对齐 Eve 的 stream replay:每条事件拥有任务内稳定 index,
 * 读取时可通过 startIndex 只回放未观察到的后缀。
 */

import {
  appendFileSync,
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const RUN_EVENT_FILE_EXT = ".jsonl";
const RUN_EVENT_SCHEMA_VERSION = 1 as const;

export interface RunEventRecord {
  kind: "event";
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
  index: number;
  channel: string;
  payload: unknown;
  timestamp: string;
}

export type RunEventInput = Omit<
  RunEventRecord,
  "kind" | "schemaVersion" | "timestamp"
> & {
  timestamp?: string;
};

export interface RunEventLog {
  appendEvent(input: RunEventInput): RunEventRecord;
  readEvents(taskId: string, startIndex?: number): RunEventRecord[];
  getEventCount(taskId: string): number;
  deleteTask(taskId: string): void;
  pruneOlderThan(cutoff: Date): number;
}

export interface RunEventCompactionResult {
  before: number;
  after: number;
}

export interface RunEventTaskSummary {
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
  eventCount: number;
  lastChannel?: string;
  lastTimestamp?: string;
}

const taskIdToFileStem = (taskId: string): string =>
  Buffer.from(taskId, "utf8").toString("base64url");

const isRunEventRecord = (value: unknown): value is RunEventRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RunEventRecord>;
  return (
    record.kind === "event" &&
    record.schemaVersion === RUN_EVENT_SCHEMA_VERSION &&
    typeof record.taskId === "string" &&
    typeof record.index === "number" &&
    Number.isInteger(record.index) &&
    record.index >= 0 &&
    typeof record.channel === "string" &&
    typeof record.timestamp === "string"
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const payloadMergeKey = (payload: unknown): string | null => {
  if (!isRecord(payload) || typeof payload.delta !== "string") return null;
  const { delta: _delta, ...rest } = payload;
  try {
    return JSON.stringify(rest);
  } catch {
    return null;
  }
};

const mergeStreamDeltaRecord = (
  previous: RunEventRecord,
  next: RunEventRecord,
): RunEventRecord | null => {
  const mergeableChannel =
    next.channel === "ai:stream-delta" ||
    next.channel === "ai:stream-reasoning";
  if (!mergeableChannel || previous.channel !== next.channel) return null;
  if (!isRecord(previous.payload) || !isRecord(next.payload)) return null;
  if (
    typeof previous.payload.delta !== "string" ||
    typeof next.payload.delta !== "string"
  ) {
    return null;
  }
  if (payloadMergeKey(previous.payload) !== payloadMergeKey(next.payload)) {
    return null;
  }
  return {
    ...next,
    payload: {
      ...next.payload,
      delta: previous.payload.delta + next.payload.delta,
    },
  };
};

export class JsonlRunEventLog implements RunEventLog {
  constructor(private readonly rootDir: string) {}

  appendEvent(input: RunEventInput): RunEventRecord {
    const record: RunEventRecord = {
      kind: "event",
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    const filePath = this.filePathForTask(input.taskId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  readEvents(taskId: string, startIndex = 0): RunEventRecord[] {
    const minIndex = Math.max(0, Math.floor(startIndex));
    return this.readAllEvents(taskId).filter(
      (event) => event.index >= minIndex,
    );
  }

  getEventCount(taskId: string): number {
    const events = this.readEvents(taskId, 0);
    if (events.length === 0) return 0;
    return Math.max(...events.map((event) => event.index)) + 1;
  }

  compactTask(taskId: string): RunEventCompactionResult {
    const events = this.readAllEvents(taskId);
    const before = events.length;
    if (before === 0) return { before: 0, after: 0 };

    const compacted: RunEventRecord[] = [];
    for (const event of events) {
      const previous = compacted[compacted.length - 1];
      const merged = previous ? mergeStreamDeltaRecord(previous, event) : null;
      if (merged) {
        compacted[compacted.length - 1] = merged;
      } else {
        compacted.push(event);
      }
    }

    if (compacted.length !== before) {
      const filePath = this.filePathForTask(taskId);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        `${compacted.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
    }

    return { before, after: compacted.length };
  }

  listTaskSummaries(): RunEventTaskSummary[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const summaries: RunEventTaskSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(RUN_EVENT_FILE_EXT)) continue;
      const filePath = path.join(this.rootDir, entry.name);
      const events = this.readAllEventsFromFile(filePath);
      if (events.length === 0) continue;
      const last = events[events.length - 1];
      summaries.push({
        taskId: last.taskId,
        sessionId: last.sessionId,
        assistantMessageId: last.assistantMessageId,
        eventCount: Math.max(...events.map((event) => event.index)) + 1,
        lastChannel: last.channel,
        lastTimestamp: last.timestamp,
      });
    }
    return summaries.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  private readAllEvents(taskId: string): RunEventRecord[] {
    return this.readAllEventsFromFile(this.filePathForTask(taskId)).filter(
      (event) => event.taskId === taskId,
    );
  }

  private readAllEventsFromFile(filePath: string): RunEventRecord[] {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    const events: RunEventRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRunEventRecord(parsed)) {
          events.push(parsed);
        }
      } catch {
        // A partially written or manually corrupted line should not make the
        // rest of the replay log unreadable.
      }
    }
    return events.sort((a, b) => a.index - b.index);
  }

  deleteTask(taskId: string): void {
    rmSync(this.filePathForTask(taskId), { force: true });
  }

  pruneOlderThan(cutoff: Date): number {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    let pruned = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(RUN_EVENT_FILE_EXT)) continue;
      const filePath = path.join(this.rootDir, entry.name);
      try {
        if (statSync(filePath).mtimeMs >= cutoff.getTime()) continue;
        rmSync(filePath, { force: true });
        pruned += 1;
      } catch {
        // Ignore races with another cleanup pass or a concurrently removed file.
      }
    }
    return pruned;
  }

  filePathForTask(taskId: string): string {
    return path.join(
      this.rootDir,
      `${taskIdToFileStem(taskId)}${RUN_EVENT_FILE_EXT}`,
    );
  }
}
