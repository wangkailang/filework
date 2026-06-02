/**
 * AI Task Control and State Management
 *
 * Manages task execution state, abort controllers, manual stop flags,
 * and tool execution tracking for concurrent AI operations.
 */

import type { WebContents } from "electron";
import { cancelBatchesForTask } from "./approval-batcher";

/** 按任务 ID 存储活跃的 AbortController，用于中止流式生成 */
export const abortControllers = new Map<string, AbortController>();

/**
 * 进行中任务的「重连」登记表。
 *
 * 渲染层刷新/重载会清空其内存状态(streamTaskIdRef=null、消息丢失),但主进程的
 * 任务仍在跑、流事件仍发往同一个 webContents(reload 不销毁 webContents)。此表
 * 按 session 暴露「当前在跑的 taskId + 助手消息 id」,供刷新后渲染层重新挂上
 * (设回 taskId/messageId、续接后续流)。只存轻量 id —— 消息内容由渲染层流式期间
 * 的节流落盘 + 续流共同负责。任务结束时由 cleanupTask 清除。
 */
/** 一条已发出的流事件(原样录制,供重连时按序重放重建消息)。 */
export interface RecordedStreamEvent {
  channel: string;
  payload: unknown;
}

export interface ActiveTaskInfo {
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
  /**
   * 当前流事件的投递目标。关窗会销毁旧 webContents,重开是全新 webContents,
   * 因此投递目标可被重连(reattachTask)重定向 —— 任务 handler 用一个读此字段的
   * 包装器发送,改这里即把整条流改投新窗口。注意:WebContents 不可序列化,
   * **不得经 IPC 返回**(见 getActiveTaskForSession 只挑可序列化字段)。
   */
  target: WebContents;
  /**
   * 已发出的流事件按序录制。重连(reattachTask)时把这串事件原样重放给新窗口,
   * 渲染层用同一套 handler 重建消息 —— 零内容缺口(对齐云端 agent 的
   * snapshot-on-reconnect)。任务结束由 cleanupTask 连同整条记录一起清除。
   */
  events: RecordedStreamEvent[];
}
export const activeTasks = new Map<string, ActiveTaskInfo>();

export const registerActiveTask = (
  info: Omit<ActiveTaskInfo, "events">,
): void => {
  activeTasks.set(info.taskId, { ...info, events: [] });
};

/**
 * 单任务录制事件的数量上限 —— 防止超长任务(海量 delta / 大体积工具结果)把内存
 * 撑爆。达到上限后停止录制(O(1)),重连重放覆盖前 MAX 条、其后由 live 流续上
 * (极长任务中段可能有小缺口)。正常任务远在此之下,完整重放不受影响。
 */
const MAX_RECORDED_EVENTS_PER_TASK = 8000;

/** 录制一条已发出的流事件(任务不存在或已达上限则忽略)。 */
export const recordTaskEvent = (
  taskId: string,
  channel: string,
  payload: unknown,
): void => {
  const t = activeTasks.get(taskId);
  if (!t || t.events.length >= MAX_RECORDED_EVENTS_PER_TASK) return;
  t.events.push({ channel, payload });
};

/** 取任务已录制的事件序列(供重连重放);无则空数组。 */
export const getTaskEvents = (taskId: string): RecordedStreamEvent[] =>
  activeTasks.get(taskId)?.events ?? [];

/** 重连时把任务的流投递目标重定向到新 webContents(关窗重开 / 跨窗口)。 */
export const redirectActiveTask = (
  taskId: string,
  target: WebContents,
): boolean => {
  const t = activeTasks.get(taskId);
  if (!t) return false;
  t.target = target;
  return true;
};

/** 任务当前的投递目标(供发送包装器实时解析)。 */
export const getActiveTaskTarget = (taskId: string): WebContents | undefined =>
  activeTasks.get(taskId)?.target;

/**
 * 返回该 session 当前在跑任务的「可序列化」信息(剥掉 target),供 IPC 返回。
 * 无则 null。
 */
export const getActiveTaskForSession = (
  sessionId: string,
): {
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
} | null => {
  for (const t of activeTasks.values()) {
    if (t.sessionId === sessionId) {
      return {
        taskId: t.taskId,
        sessionId: t.sessionId,
        assistantMessageId: t.assistantMessageId,
      };
    }
  }
  return null;
};

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

  // 从重连登记表移除 —— 任务已结束,刷新后不应再尝试重挂。
  activeTasks.delete(taskId);

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
