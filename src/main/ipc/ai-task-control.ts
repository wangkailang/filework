/**
 * AI 任务控制与状态管理
 *
 * 管理任务执行状态、abort controller、手动停止标志，
 * 以及并发 AI 操作的工具执行跟踪。
 */

import type { WebContents } from "electron";
import type { RunEventLog, RunEventRecord } from "../core/run/event-log";
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
  /**
   * 任务内单调递增的事件序号。渲染层可在重连时传 startIndex,
   * 只回放尚未观察到的后缀。
   */
  index: number;
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
  /** 任务内已观察到的流事件总数。内存缓存可截断,该计数不可回退。 */
  eventCount: number;
}
export const activeTasks = new Map<string, ActiveTaskInfo>();

let runEventLog: RunEventLog | null = null;

export const setRunEventLog = (log: RunEventLog | null): void => {
  runEventLog = log;
};

export const setRunEventLogForTesting = setRunEventLog;

export const registerActiveTask = (
  info: Omit<ActiveTaskInfo, "events" | "eventCount">,
): void => {
  activeTasks.set(info.taskId, { ...info, events: [], eventCount: 0 });
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
): RecordedStreamEvent | null => {
  const t = activeTasks.get(taskId);
  if (!t) return null;
  const event: RecordedStreamEvent = {
    index: t.eventCount,
    channel,
    payload,
  };
  t.eventCount += 1;
  if (t.events.length < MAX_RECORDED_EVENTS_PER_TASK) {
    t.events.push(event);
  }
  if (runEventLog) {
    try {
      runEventLog.appendEvent({
        taskId,
        sessionId: t.sessionId,
        assistantMessageId: t.assistantMessageId,
        ...event,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(
        "[Task Control] Failed to persist run stream event:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return event;
};

const toRecordedStreamEvent = (event: RunEventRecord): RecordedStreamEvent => ({
  index: event.index,
  channel: event.channel,
  payload: event.payload,
});

/** 取任务已录制的事件序列(供重连重放);无则空数组。 */
export const getTaskEvents = (
  taskId: string,
  startIndex = 0,
): RecordedStreamEvent[] => {
  if (runEventLog) {
    try {
      const persisted = runEventLog.readEvents(taskId, startIndex);
      if (persisted.length > 0) return persisted.map(toRecordedStreamEvent);
    } catch (err) {
      console.warn(
        "[Task Control] Failed to read persisted run stream events:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const events = activeTasks.get(taskId)?.events ?? [];
  if (startIndex <= 0) return events;
  return events.filter((event) => event.index >= startIndex);
};

const getRecordedEventCount = (task: ActiveTaskInfo): number => {
  if (runEventLog) {
    try {
      return Math.max(task.eventCount, runEventLog.getEventCount(task.taskId));
    } catch (err) {
      console.warn(
        "[Task Control] Failed to count persisted run stream events:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return task.eventCount;
};

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
  streamEventCount: number;
} | null => {
  for (const t of activeTasks.values()) {
    if (t.sessionId === sessionId) {
      return {
        taskId: t.taskId,
        sessionId: t.sessionId,
        assistantMessageId: t.assistantMessageId,
        streamEventCount: getRecordedEventCount(t),
      };
    }
  }
  return null;
};

export interface ActiveTaskSnapshot {
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
  streamEventCount: number;
}

/** 返回全部活跃任务的可序列化快照,供会话列表恢复/展示运行态。 */
export const getActiveTasks = (): ActiveTaskSnapshot[] =>
  Array.from(activeTasks.values()).map((t) => ({
    taskId: t.taskId,
    sessionId: t.sessionId,
    assistantMessageId: t.assistantMessageId,
    streamEventCount: getRecordedEventCount(t),
  }));

/** 按任务 ID 存储手动停止标志，用于强制中止流式生成 */
export const manualStopFlags = new Map<string, boolean>();

/** 运行中 steering:用户追加给下一次模型 step 的轻量指令队列。 */
const taskSteeringMessages = new Map<string, string[]>();

export const enqueueTaskSteering = (
  taskId: string,
  message: string,
): boolean => {
  const trimmed = message.trim();
  if (!taskId || !trimmed) return false;
  const current = taskSteeringMessages.get(taskId) ?? [];
  taskSteeringMessages.set(taskId, [...current, trimmed]);
  return true;
};

export const drainTaskSteeringMessages = (taskId: string): string[] => {
  const messages = taskSteeringMessages.get(taskId);
  if (!messages || messages.length === 0) return [];
  taskSteeringMessages.delete(taskId);
  return messages;
};

/** 按任务 ID 跟踪活跃的工具执行，用于取消 */
export const activeToolExecutions = new Map<string, Set<AbortController>>();

/** 工具调用审批等待队列 */
export const pendingApprovals = new Map<string, (approved: boolean) => void>();

/**
 * 内联 `createPlan` 的 plan id 约定。由 createPlan 工具写入，
 * 由 approve/reject/cancel 这几个 IPC handler 解析以路由回挂起的 Promise。
 * 写入端与读取端的前缀必须保持一致 ——
 * 请使用下方的辅助函数，而不要手写 `"inline-" + taskId`。
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
 * 原子地取出并调用某任务挂起的 inline-plan resolver。
 * 用它替代「先 get 再 delete 再 call」，以免并发的
 * cleanup/stop/reject 各处对同一 Promise 重复 resolve。
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
 * Plan gate（计划门控）：当某个 draft `createPlan` 正等待审批时，同一任务的
 * 其余所有工具都会 await 这个 promise（审批通过 resolve 为 `true`，拒绝则
 * 为 `false`）。createPlan 在挂起时登记它，结算后该条目自动清除。
 * 无待处理计划时 `awaitPlanGate` 返回 null，因此常规路径不增加任何延迟。
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
 * 待处理的 `askClarification` 工具调用，以每次调用的 UUID
 * （`clarificationId`）为 key，而非 taskId。若以 taskId 为 key，并发的
 * 第二次澄清会通过 Map.set 覆盖第一个 resolver，导致第一个 Promise 永久泄漏；
 * 改为按调用维度作 key，可让每次挂起相互独立。
 *
 * 每条记录都携带其所属 taskId，以便 `cleanupTask` /
 * `stopTaskExecution` 在拆解时清扫某任务的全部澄清。
 *
 * `answer === null` ⇒ 取消（任务被停止 / 清理）。此时工具 reject，
 * 让 agent loop 暴露错误，而不是用空字符串继续。
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

/** 清空属于指定任务的全部待处理澄清。由 cleanupTask /
 *  stopTaskExecution 用于结算（以 null 表示已取消）该任务遗留的
 *  在途澄清。 */
export const drainClarificationsForTask = (taskId: string): void => {
  for (const [cid, entry] of pendingClarifications) {
    if (entry.taskId === taskId) {
      pendingClarifications.delete(cid);
      entry.resolve(null);
    }
  }
};

/**
 * 在已批准计划下运行的任务 —— writeFile 跳过逐次审批，
 * 以免阻塞计划执行。
 * deleteFile 与 moveFile 仍需审批（破坏性）。
 *
 * 映射 taskId → workspacePath，用于按路径作用域校验。
 */
const planApprovedTasks = new Map<string, string>();

/** 将任务标记为计划已批准，写入操作限定在 workspacePath 范围内。 */
export const markPlanApproved = (
  taskId: string,
  workspacePath: string,
): void => {
  planApprovedTasks.set(taskId, workspacePath);
};

/** 检查任务是否计划已批准，返回其工作区路径，否则返回 undefined。 */
export const getPlanApprovedWorkspace = (taskId: string): string | undefined =>
  planApprovedTasks.get(taskId);

/** 工具调用与任务的映射关系，用于清理 */
export const toolCallToTaskMap = new Map<string, string>();

/** taskId → workspacePath 映射，用于按路径作用域的限制（如 runCommand 的 cwd） */
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
 * 为指定任务 ID 初始化任务执行跟踪
 */
export const initTaskExecution = (taskId: string): void => {
  if (!activeToolExecutions.has(taskId)) {
    activeToolExecutions.set(taskId, new Set());
  }
};

/**
 * 清理某任务的全部跟踪数据
 */
export const cleanupTask = (taskId: string): void => {
  // 清理 abort controller
  abortControllers.delete(taskId);

  // 从重连登记表移除 —— 任务已结束,刷新后不应再尝试重挂。
  activeTasks.delete(taskId);

  if (runEventLog) {
    try {
      runEventLog.deleteTask(taskId);
    } catch (err) {
      console.warn(
        "[Task Cleanup] Failed to delete persisted run stream events:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 清理手动停止标志
  manualStopFlags.delete(taskId);

  // 清理运行中 steering 队列
  taskSteeringMessages.delete(taskId);

  // 清理计划已批准映射
  planApprovedTasks.delete(taskId);

  // 清理任务工作区映射
  taskWorkspaces.delete(taskId);

  // 清理活跃的工具执行
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

  // 清理该任务的待处理审批
  for (const [toolCallId, taskIdForCall] of toolCallToTaskMap) {
    if (taskIdForCall === taskId) {
      pendingApprovals.delete(toolCallId);
      toolCallToTaskMap.delete(toolCallId);
    }
  }

  // 清理该任务的内联 plan draft 审批状态
  drainPlanResolver(taskId, false);
  approvedInlinePlanTasks.delete(taskId);

  // 拒绝属于该任务的每一个待处理 askClarification 挂起，
  // 让等待中的工具调用得以结算（被拒绝），而不是泄漏 agent loop。
  // 一个任务可能同时有多个在途澄清 —— 全部清扫。
  drainClarificationsForTask(taskId);
};

/**
 * 停止某任务的全部执行
 */
export const stopTaskExecution = (taskId: string): boolean => {
  console.log("[Task Control] Stopping execution for task:", taskId);

  // 先设置手动停止标志
  manualStopFlags.set(taskId, true);

  // 中止主 controller
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

  // 中止所有活跃的工具执行
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

  // 拒绝待处理的工具审批
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

  // 拒绝该任务在途的批量审批（缓冲中 + 已 flush）。
  // 各条目的 abort 信号本就会及时结算，但这次显式清扫可防止
  // 信号未被传播的孤儿条目残留。
  cancelBatchesForTask(taskId);

  // 拒绝任何待处理的内联 createPlan draft 审批 ——
  // 让等待中的工具调用得以结算，而不是泄漏 agent loop。
  drainPlanResolver(taskId, false);

  // 属于该任务的每一个 askClarification 挂起也同样处理。
  drainClarificationsForTask(taskId);

  return stopped;
};
