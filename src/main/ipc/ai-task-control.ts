/**
 * AI Task Control and State Management
 *
 * Manages task execution state, abort controllers, manual stop flags,
 * and tool execution tracking for concurrent AI operations.
 */

/** 按任务 ID 存储活跃的 AbortController，用于中止流式生成 */
export const abortControllers = new Map<string, AbortController>();

/** 按任务 ID 存储手动停止标志，用于强制中止流式生成 */
export const manualStopFlags = new Map<string, boolean>();

/** 按任务 ID 跟踪活跃的工具执行，用于取消 */
export const activeToolExecutions = new Map<string, Set<AbortController>>();

/** 工具调用审批等待队列 */
export const pendingApprovals = new Map<string, (approved: boolean) => void>();

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

/**
 * Per-task tool whitelist: once a user approves a dangerous tool (e.g.
 * writeFile) during a task, subsequent calls of the same tool type are
 * auto-approved for the remainder of that task. This reduces approval
 * fatigue without compromising security across tasks.
 */
const taskToolWhitelist = new Map<string, Set<string>>();

/** Record that `toolName` was user-approved for `taskId`. */
export const whitelistToolForTask = (
  taskId: string,
  toolName: string,
): void => {
  let set = taskToolWhitelist.get(taskId);
  if (!set) {
    set = new Set();
    taskToolWhitelist.set(taskId, set);
  }
  set.add(toolName);
};

/** Check if `toolName` has been previously approved for `taskId`. */
export const isToolWhitelistedForTask = (
  taskId: string,
  toolName: string,
): boolean => {
  return taskToolWhitelist.get(taskId)?.has(toolName) ?? false;
};

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

  // Clean up per-task tool whitelist
  taskToolWhitelist.delete(taskId);

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

  return stopped;
};
