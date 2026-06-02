// 基于 `createForkSkillRunner` 的有界并发调度器。每个
// 子任务的 parentSignal 由 `deps.parentSignal` 级联而来;failFast
// 会在首个非 ok 报告出现时中止所有剩余 worker。

import { randomUUID } from "node:crypto";
import type {
  SubAgentContract,
  SubAgentReport,
} from "../core/agent/sub-agent-contract";
import {
  createForkSkillRunner,
  type ForkSkillRunnerDeps,
  type RunSubagentOptions,
} from "./fork-skill-runner";

export interface ForkPoolItem {
  contract: SubAgentContract;
  systemPrompt: string;
  workspacePath: string;
  allowedTools?: string[];
  modelOverrideId?: string;
  /** 每个子任务的 task id 覆盖项;若省略则生成一个 UUID。 */
  taskId?: string;
}

export interface RunForkBatchOptions {
  /** 最大并发子任务数。默认 3。钳制到 [1, items.length]。 */
  concurrency?: number;
  /** 若为 true,首个非 ok 报告将中止所有剩余子任务。 */
  failFast?: boolean;
  /** 标记在批次结果上的稳定 id,供渲染层对子任务分组。 */
  forkBatchId?: string;
}

export interface ForkBatchResult {
  forkBatchId: string;
  reports: SubAgentReport[];
}

export async function runForkBatch(
  items: ForkPoolItem[],
  deps: Omit<ForkSkillRunnerDeps, "taskId" | "parentSignal"> & {
    parentSignal: AbortSignal;
  },
  opts: RunForkBatchOptions = {},
): Promise<ForkBatchResult> {
  const forkBatchId = opts.forkBatchId ?? `batch-${randomUUID()}`;
  const failFast = opts.failFast === true;
  const concurrency = clamp(opts.concurrency ?? 3, 1, items.length || 1);

  const reports = new Array<SubAgentReport | undefined>(items.length);

  // 每批次的级联控制器 —— 当 failFast 命中失败时翻转。
  // 子任务把 `batchSignal` 作为各自的 parentSignal 消费。
  const batchController = new AbortController();
  const onParentAbort = () => {
    if (!batchController.signal.aborted) batchController.abort();
  };
  if (deps.parentSignal.aborted) {
    batchController.abort();
  } else {
    deps.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      if (batchController.signal.aborted) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx];
      const childTaskId = item.taskId ?? `${forkBatchId}:${idx}`;
      const runner = createForkSkillRunner({
        ...deps,
        taskId: childTaskId,
        parentSignal: batchController.signal,
      });
      const runOpts: RunSubagentOptions = {
        systemPrompt: item.systemPrompt,
        workspacePath: item.workspacePath,
        prompt: item.contract.input.prompt,
        history: item.contract.input.contextSlice,
        allowedTools: item.allowedTools,
        modelOverrideId: item.modelOverrideId,
        contract: item.contract,
      };
      try {
        const report = await runner(runOpts);
        reports[idx] = report;
        if (failFast && report.status !== "ok") {
          batchController.abort();
        }
      } catch (err) {
        reports[idx] = {
          agentId: childTaskId,
          status: "failed",
          summary: "",
          usage: {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          },
          toolCallCount: 0,
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        if (failFast) batchController.abort();
      }
    }
  };

  try {
    const workers = Array.from({ length: concurrency }, () => runWorker());
    await Promise.all(workers);
  } finally {
    deps.parentSignal.removeEventListener("abort", onParentAbort);
  }

  // 任何从未启动的槽位(failFast 级联)都会得到一个合成的 cancelled 报告。
  for (let i = 0; i < items.length; i++) {
    if (reports[i] === undefined) {
      reports[i] = {
        agentId: items[i].taskId ?? `${forkBatchId}:${i}`,
        status: "cancelled",
        summary: "",
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
        toolCallCount: 0,
        durationMs: 0,
        error: "cancelled before start (failFast cascade)",
      };
    }
  }

  return {
    forkBatchId,
    reports: reports as SubAgentReport[],
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
