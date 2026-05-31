/**
 * AI Task Control and State Management
 *
 * Manages task execution state, abort controllers, manual stop flags,
 * and tool execution tracking for concurrent AI operations.
 */

import { cancelBatchesForTask } from "./approval-batcher";

/** 按任务 ID 存储活跃的 AbortController，用于中止流式生成 */
export const abortControllers = new Map<string, AbortController>();

/** 按任务 ID 存储手动停止标志，用于强制中止流式生成 */
export const manualStopFlags = new Map<string, boolean>();

/** 按任务 ID 跟踪活跃的工具执行，用于取消 */
export const activeToolExecutions = new Map<string, Set<AbortController>>();

/** 工具调用审批等待队列 */
export const pendingApprovals = new Map<string, (approved: boolean) => void>();

/**
 * Inline `createPlan` plan id convention. Written by the createPlan tool,
 * parsed by the approve/reject/cancel IPC handlers to route back to the
 * suspended Promise. Keep the prefix in sync between write + read sites
 * — use the helpers below instead of hand-rolling `"inline-" + taskId`.
 */
export const INLINE_PLAN_PREFIX = "inline-";
export const makeInlinePlanId = (taskId: string): string =>
  `${INLINE_PLAN_PREFIX}${taskId}`;
export const parseInlinePlanId = (planId: string): string | null =>
  planId.startsWith(INLINE_PLAN_PREFIX)
    ? planId.slice(INLINE_PLAN_PREFIX.length)
    : null;

/**
 * Inline `createPlan` draft审批等待队列。
 *
 * createPlan 工具在每个 task 的首次调用时会以 status="draft" 发送 plan,
 * 然后挂起一个 Promise 等待用户点击「开始」/「拒绝」。renderer 触发的
 * ai:approvePlan / ai:rejectPlan 通过该 map 解锁 Promise:
 *   - approved=true  → 工具返回成功,agent 继续后续步骤
 *   - approved=false → 工具抛出 rejection,agent loop 视作错误并终止
 *
 * 同一 task 的后续 createPlan 调用(状态更新)不再走 draft 流程,直接返回。
 */
export const pendingPlanApprovals = new Map<
  string,
  (approved: boolean) => void
>();

/** 已通过用户审批的 inline plan 所属 taskId 集合(用于跳过后续 draft)。 */
export const approvedInlinePlanTasks = new Set<string>();

/**
 * Atomically take + invoke the pending inline-plan resolver for a task.
 * Use this instead of `get` then `delete` then `call` so concurrent
 * cleanup/stop/reject sites can't double-resolve the Promise.
 */
export const drainPlanResolver = (
  taskId: string,
  approved: boolean,
): boolean => {
  const resolver = pendingPlanApprovals.get(taskId);
  if (!resolver) return false;
  pendingPlanApprovals.delete(taskId);
  resolver(approved);
  return true;
};

/**
 * Plan gate: while a draft `createPlan` awaits approval, every OTHER tool of
 * the same task awaits this promise (resolves `true` on approve, `false` on
 * reject). createPlan registers it when it suspends; the entry self-clears
 * once settled. `awaitPlanGate` returns null when no plan is pending, so the
 * common path adds no latency.
 */
const planApprovalGates = new Map<string, Promise<boolean>>();

export const registerPlanGate = (
  taskId: string,
  gate: Promise<boolean>,
): void => {
  planApprovalGates.set(taskId, gate);
  void gate.finally(() => {
    if (planApprovalGates.get(taskId) === gate) {
      planApprovalGates.delete(taskId);
    }
  });
};

export const awaitPlanGate = (taskId: string): Promise<boolean> | null =>
  planApprovalGates.get(taskId) ?? null;

/**
 * Pending `askClarification` tool calls keyed by a per-call UUID
 * (`clarificationId`), not by taskId. Keying by taskId let a concurrent
 * second clarification overwrite the first resolver via Map.set and the
 * first Promise leaked forever; keying per-call makes each suspension
 * independent.
 *
 * Each entry carries its owning taskId so `cleanupTask` /
 * `stopTaskExecution` can sweep all clarifications for a task on
 * teardown.
 *
 * `answer === null` ⇒ cancellation (task stopped / cleaned). The tool
 * rejects so the agent loop surfaces an error rather than continuing
 * with an empty string.
 */
export interface PendingClarification {
  taskId: string;
  resolve: (answer: string | null) => void;
}
export const pendingClarifications = new Map<string, PendingClarification>();

export const drainClarificationResolver = (
  clarificationId: string,
  answer: string | null,
): boolean => {
  const entry = pendingClarifications.get(clarificationId);
  if (!entry) return false;
  pendingClarifications.delete(clarificationId);
  entry.resolve(answer);
  return true;
};

/** Drain every pending clarification belonging to the given task. Used
 *  by cleanupTask / stopTaskExecution to settle (with null = cancelled)
 *  any clarifications the task left in flight. */
export const drainClarificationsForTask = (taskId: string): void => {
  for (const [cid, entry] of pendingClarifications) {
    if (entry.taskId === taskId) {
      pendingClarifications.delete(cid);
      entry.resolve(null);
    }
  }
};

/**
 * Tasks running under an approved plan — writeFile skips individual
 * approval to avoid blocking plan execution.
 * deleteFile and moveFile still require approval (destructive).
 *
 * Maps taskId → workspacePath for path-scoped validation.
 */
const planApprovedTasks = new Map<string, string>();

/** Mark a task as plan-approved, scoped to writes within workspacePath. */
export const markPlanApproved = (
  taskId: string,
  workspacePath: string,
): void => {
  planApprovedTasks.set(taskId, workspacePath);
};

/** Check if a task is plan-approved and return its workspace path, or undefined. */
export const getPlanApprovedWorkspace = (taskId: string): string | undefined =>
  planApprovedTasks.get(taskId);

/** 工具调用与任务的映射关系，用于清理 */
export const toolCallToTaskMap = new Map<string, string>();

/** taskId → workspacePath mapping for path-scoped restrictions (e.g. runCommand cwd) */
const taskWorkspaces = new Map<string, string>();

export const setTaskWorkspace = (
  taskId: string,
  workspacePath: string,
): void => {
  taskWorkspaces.set(taskId, workspacePath);
};

export const getTaskWorkspace = (taskId: string): string | undefined =>
  taskWorkspaces.get(taskId);

// 注:工具白名单已迁移到持久化的 `./tool-whitelist`(跨任务/会话生效、
// 可在设置面板管理),不再使用「按任务、内存态」的临时白名单。

/**
 * Initialize task execution tracking for a given task ID
 */
export const initTaskExecution = (taskId: string): void => {
  if (!activeToolExecutions.has(taskId)) {
    activeToolExecutions.set(taskId, new Set());
  }
};

/**
 * Clean up all tracking data for a task
 */
export const cleanupTask = (taskId: string): void => {
  // Clean up abort controller
  abortControllers.delete(taskId);

  // Clean up manual stop flag
  manualStopFlags.delete(taskId);

  // Clean up plan-approved mapping
  planApprovedTasks.delete(taskId);

  // Clean up task workspace mapping
  taskWorkspaces.delete(taskId);

  // Clean up active tool executions
  const toolControllers = activeToolExecutions.get(taskId);
  if (toolControllers) {
    toolControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch (err) {
        console.warn("[Task Cleanup] Failed to abort tool execution:", err);
      }
    });
    activeToolExecutions.delete(taskId);
  }

  // Clean up pending approvals for this task
  for (const [toolCallId, taskIdForCall] of toolCallToTaskMap) {
    if (taskIdForCall === taskId) {
      pendingApprovals.delete(toolCallId);
      toolCallToTaskMap.delete(toolCallId);
    }
  }

  // Clean up inline plan draft approval state for this task
  drainPlanResolver(taskId, false);
  approvedInlinePlanTasks.delete(taskId);

  // Reject every pending askClarification suspension belonging to this
  // task so awaiting tool calls settle (rejecting) instead of leaking
  // the agent loop. Multiple clarifications can be in flight for one
  // task — sweep them all.
  drainClarificationsForTask(taskId);
};

/**
 * Stop all executions for a task
 */
export const stopTaskExecution = (taskId: string): boolean => {
  console.log("[Task Control] Stopping execution for task:", taskId);

  // Set manual stop flag first
  manualStopFlags.set(taskId, true);

  // Abort main controller
  const controller = abortControllers.get(taskId);
  let stopped = false;
  if (controller) {
    console.log("[Task Control] Found controller, calling abort()");
    console.log(
      "[Task Control] Controller aborted signal:",
      controller.signal.aborted,
      "→",
      true,
    );
    controller.abort();
    console.log("[Task Control] Successfully aborted and removed controller");
    stopped = true;
  }

  // Abort all active tool executions
  const toolControllers = activeToolExecutions.get(taskId);
  if (toolControllers) {
    console.log(
      `[Task Control] Aborting ${toolControllers.size} active tool executions for task:`,
      taskId,
    );
    toolControllers.forEach((toolController) => {
      try {
        toolController.abort();
        console.log("[Task Control] Aborted tool execution");
      } catch (err) {
        console.warn("[Task Control] Failed to abort tool execution:", err);
      }
    });
    toolControllers.clear();
  }

  // Reject pending tool approvals
  for (const [toolCallId, taskIdForCall] of toolCallToTaskMap) {
    if (taskIdForCall === taskId) {
      const resolve = pendingApprovals.get(toolCallId);
      if (resolve) {
        console.log(
          "[Task Control] Rejecting pending tool approval for stopped task",
        );
        resolve(false);
        pendingApprovals.delete(toolCallId);
        toolCallToTaskMap.delete(toolCallId);
      }
    }
  }

  // Reject any in-flight batched approvals (buffering + flushed) for
  // this task. Per-entry abort signals already settle promptly, but
  // this explicit sweep guards against orphaned entries whose signal
  // wasn't propagated.
  cancelBatchesForTask(taskId);

  // Reject any pending inline createPlan draft approval — so the
  // awaiting tool call settles instead of leaking the agent loop.
  drainPlanResolver(taskId, false);

  // Same for every askClarification suspension belonging to this task.
  drainClarificationsForTask(taskId);

  return stopped;
};
