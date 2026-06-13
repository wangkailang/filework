export type SessionRunState =
  | {
      status: "pending";
      assistantMessageId?: string;
    }
  | {
      status: "running";
      taskId: string;
      assistantMessageId?: string;
    }
  | {
      status: "unread";
      assistantMessageId?: string;
    };

export type SessionRunStateMap = Record<string, SessionRunState>;

export type PendingTaskRoute = {
  sessionId?: string;
  assistantMessageId?: string;
};

export type RunningTaskRoute = {
  sessionId?: string;
  taskId: string;
  assistantMessageId?: string;
};

export const markSessionPending = (
  state: SessionRunStateMap,
  task: PendingTaskRoute,
): SessionRunStateMap => {
  if (!task.sessionId) return state;
  return {
    ...state,
    [task.sessionId]: {
      status: "pending",
      assistantMessageId: task.assistantMessageId,
    },
  };
};

export const markSessionRunning = (
  state: SessionRunStateMap,
  task: RunningTaskRoute,
): SessionRunStateMap => {
  if (!task.sessionId) return state;
  return {
    ...state,
    [task.sessionId]: {
      status: "running",
      taskId: task.taskId,
      assistantMessageId: task.assistantMessageId,
    },
  };
};

export const clearSessionRunStateByTask = (
  state: SessionRunStateMap,
  taskId: string,
): SessionRunStateMap => {
  let changed = false;
  const next: SessionRunStateMap = {};
  for (const [sessionId, runState] of Object.entries(state)) {
    if (runState.status === "running" && runState.taskId === taskId) {
      changed = true;
      continue;
    }
    next[sessionId] = runState;
  }
  return changed ? next : state;
};

export const clearSessionRunState = (
  state: SessionRunStateMap,
  sessionId: string,
): SessionRunStateMap => {
  if (!state[sessionId]) return state;
  const { [sessionId]: _removed, ...next } = state;
  return next;
};

export const settleSessionRunStateByTask = (
  state: SessionRunStateMap,
  taskId: string,
  activeSessionId: string | null | undefined,
): SessionRunStateMap => {
  let changed = false;
  const next: SessionRunStateMap = {};
  for (const [sessionId, runState] of Object.entries(state)) {
    if (runState.status !== "running" || runState.taskId !== taskId) {
      next[sessionId] = runState;
      continue;
    }
    changed = true;
    if (sessionId !== activeSessionId) {
      next[sessionId] = {
        status: "unread",
        assistantMessageId: runState.assistantMessageId,
      };
    }
  }
  return changed ? next : state;
};

export const clearSessionUnreadState = (
  state: SessionRunStateMap,
  sessionId: string,
): SessionRunStateMap => {
  if (state[sessionId]?.status !== "unread") return state;
  const { [sessionId]: _removed, ...next } = state;
  return next;
};

export const getSessionRunState = (
  state: SessionRunStateMap,
  sessionId: string | null | undefined,
): SessionRunState | null => {
  if (!sessionId) return null;
  return state[sessionId] ?? null;
};
