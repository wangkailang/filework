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

const isAutomationUpdateTool = (toolName: string) =>
  toolName === "automation_update";

const getAutomationAction = (args: unknown): string | null => {
  if (!isRecord(args) || typeof args.action !== "string") return null;
  return args.action;
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
  if (isAutomationUpdateTool(toolName)) {
    return LL.approval_automationUpdate_title();
  }
  if (entries.length === 1) return LL.approval_batch_title_single(label);
  return LL.approval_batch_title_multiple(entries.length, label);
};

export const getBatchApproveLabel = ({
  LL,
  toolName,
  count,
}: {
  LL: TranslationFunctions;
  toolName: string;
  count: number;
}): string => {
  if (count === 1 && isAutomationUpdateTool(toolName)) {
    return LL.approval_automationUpdate_approve_once();
  }
  if (count === 1) return LL.chat_approve();
  return LL.approval_batch_approve_all(count);
};

export const getBatchAlwaysAllowLabel = ({
  LL,
  toolName,
}: {
  LL: TranslationFunctions;
  toolName: string;
}): string => {
  if (isAutomationUpdateTool(toolName)) {
    return LL.approval_automationUpdate_always_allow();
  }
  return LL.approval_batch_always_allow(getBatchToolLabel(LL, toolName));
};

export const summarizeBatchEntry = (
  toolName: string,
  entry: BatchApprovalEntry,
  LL: TranslationFunctions,
): string | null => {
  if (isAutomationUpdateTool(toolName)) {
    const action = getAutomationAction(entry.args);
    if (action === "create")
      return LL.approval_automationUpdate_summary_create();
    if (action === "update")
      return LL.approval_automationUpdate_summary_update();
    if (action === "delete")
      return LL.approval_automationUpdate_summary_delete();
    if (action === "list") return LL.approval_automationUpdate_summary_list();
    return LL.approval_automationUpdate_summary_change();
  }
  if (toolName !== "spawnSubagent") return null;
  const taskCount = getSpawnSubagentTaskCount(entry.args);
  const concurrency = getSpawnSubagentConcurrency(entry.args, taskCount);
  return LL.approval_spawnSubagent_summary(taskCount, concurrency);
};
