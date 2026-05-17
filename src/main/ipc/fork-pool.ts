// Bounded-concurrency dispatcher over `createForkSkillRunner`. Each
// child's parentSignal is cascaded from `deps.parentSignal`; failFast
// aborts all remaining workers on the first non-ok report.

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
  /** Per-child task id override; if omitted a UUID is minted. */
  taskId?: string;
}

export interface RunForkBatchOptions {
  /** Max in-flight children. Default 3. Clamped to [1, items.length]. */
  concurrency?: number;
  /** If true, the first non-ok report aborts all remaining children. */
  failFast?: boolean;
  /** Stable id tagged on the batch result so the renderer can group children. */
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

  // Per-batch cascade controller — flipped when failFast hits a failure.
  // Children consume `batchSignal` as their parentSignal.
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

  // Any never-started slots (failFast cascade) get a synthetic cancelled report.
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
