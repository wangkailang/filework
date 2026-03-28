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

/** 工具调用与任务的映射关系，用于清理 */
export const toolCallToTaskMap = new Map<string, string>();

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

  // Clean up active tool executions
  const toolControllers = activeToolExecutions.get(taskId);
  if (toolControllers) {
    toolControllers.forEach(controller => {
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
    console.log("[Task Control] Controller aborted signal:", controller.signal.aborted, "→", true);
    controller.abort();
    console.log("[Task Control] Successfully aborted and removed controller");
    stopped = true;
  }

  // Abort all active tool executions
  const toolControllers = activeToolExecutions.get(taskId);
  if (toolControllers) {
    console.log(`[Task Control] Aborting ${toolControllers.size} active tool executions for task:`, taskId);
    toolControllers.forEach(toolController => {
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
        console.log("[Task Control] Rejecting pending tool approval for stopped task");
        resolve(false);
        pendingApprovals.delete(toolCallId);
        toolCallToTaskMap.delete(toolCallId);
      }
    }
  }

  return stopped;
};