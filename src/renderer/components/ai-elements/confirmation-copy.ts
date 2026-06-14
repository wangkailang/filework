import type { BatchApprovalEntry } from "../../../main/core/session/message-parts";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import { getToolLabels } from "./tool-labels";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getSpawnSubagentTaskCount = (args: unknown): number => {
  if (!isRecord(args) || !Array.isArray(args.tasks)) return 1;
  return Math.max(1, args.tasks.length);
};

const getSpawnSubagentConcurrency = (
  args: unknown,
  taskCount: number,
): number => {
  if (!isRecord(args) || typeof args.concurrency !== "number") {
    return Math.min(3, taskCount);
  }
  return Math.max(1, Math.min(args.concurrency, taskCount));
};

export const getBatchToolLabel = (
  LL: TranslationFunctions,
  toolName: string,
): string => {
  if (toolName === "spawnSubagent") return LL.toolName_spawnSubagent();
  return getToolLabels(LL)[toolName] || toolName;
};

export const getBatchApprovalTitle = ({
  LL,
  toolName,
  entries,
}: {
  LL: TranslationFunctions;
  toolName: string;
  entries: BatchApprovalEntry[];
}): string => {
  const label = getBatchToolLabel(LL, toolName);
  if (entries.length === 1) return LL.approval_batch_title_single(label);
  return LL.approval_batch_title_multiple(entries.length, label);
};

export const summarizeBatchEntry = (
  toolName: string,
  entry: BatchApprovalEntry,
  LL: TranslationFunctions,
): string | null => {
  if (toolName !== "spawnSubagent") return null;
  const taskCount = getSpawnSubagentTaskCount(entry.args);
  const concurrency = getSpawnSubagentConcurrency(entry.args, taskCount);
  return LL.approval_spawnSubagent_summary(taskCount, concurrency);
};
