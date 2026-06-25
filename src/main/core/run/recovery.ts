import type { JsonlRunEventLog } from "./event-log";

export const INTERRUPTED_RUN_MESSAGE =
  "Task interrupted because the application exited before the run completed. Please rerun the request if you still need it.";

export interface InterruptedRunRecovery {
  taskId: string;
  sessionId?: string;
  assistantMessageId?: string;
  terminal: boolean;
}

interface RecoveryOptions {
  now?: Date;
  updateTask: (
    taskId: string,
    updates: {
      status: "failed";
      result: string;
      completedAt: string;
      updatedAt: string;
    },
  ) => void | Promise<void>;
  appendInterruptedMessage?: (input: {
    sessionId: string;
    assistantMessageId: string;
    message: string;
    timestamp: string;
  }) => void | Promise<void>;
}

const TERMINAL_CHANNELS = new Set(["ai:stream-done", "ai:stream-error"]);

export const recoverInterruptedRunEventLogs = async (
  log: JsonlRunEventLog,
  { now = new Date(), updateTask, appendInterruptedMessage }: RecoveryOptions,
): Promise<InterruptedRunRecovery[]> => {
  const completedAt = now.toISOString();
  const recovered: InterruptedRunRecovery[] = [];

  for (const summary of log.listTaskSummaries()) {
    const terminal =
      summary.lastChannel !== undefined &&
      TERMINAL_CHANNELS.has(summary.lastChannel);

    // Residual logs are only processed during cold start, before any renderer
    // can hold a stream cursor. Compact first so manual/debug inspection stays
    // small even if status update/delete below fails.
    log.compactTask(summary.taskId);

    if (!terminal) {
      await updateTask(summary.taskId, {
        status: "failed",
        result: INTERRUPTED_RUN_MESSAGE,
        completedAt,
        updatedAt: completedAt,
      });
      if (summary.sessionId && summary.assistantMessageId) {
        await appendInterruptedMessage?.({
          sessionId: summary.sessionId,
          assistantMessageId: summary.assistantMessageId,
          message: INTERRUPTED_RUN_MESSAGE,
          timestamp: completedAt,
        });
      }
    }

    log.deleteTask(summary.taskId);
    recovered.push({
      taskId: summary.taskId,
      sessionId: summary.sessionId,
      assistantMessageId: summary.assistantMessageId,
      terminal,
    });
  }

  return recovered;
};
