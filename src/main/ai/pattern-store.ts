// 即发即忘的 JSONL 采集落地点。在调用 initPatternStore() 之前为空操作。
// 写入通过一层深的 promise 链串行化,使 JSONL 行在并发追加时不会交错。

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

/** 串行化链 —— 每次 appendPattern() 都链接在上一次写入之后。 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 配置 JSONL 文件路径。生产环境:在应用启动时调用一次,传入
 * `join(app.getPath("userData"), "patterns.jsonl")`。测试:传入
 * 临时目录路径。
 */
export function initPatternStore(absolutePath: string): void {
  storePath = absolutePath;
}

export function getPatternStorePath(): string | undefined {
  return storePath;
}

/** 供测试重置。 */
export function __resetPatternStoreForTests(): void {
  storePath = undefined;
  writeChain = Promise.resolve();
}

/**
 * 即发即忘的追加。返回写入 promise 以便测试可以 await ——
 * 生产环境调用方忽略返回值。
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

/** 测试辅助函数 —— 读取并解析所有记录。 */
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
