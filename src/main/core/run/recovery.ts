import type {
  MessagePart,
  SubagentChildView,
  SubagentMessagePart,
  ToolState,
} from "../session/message-parts";
import type { JsonlRunEventLog, RunEventRecord } from "./event-log";

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
  appendRecoveredMessageParts?: (input: {
    sessionId: string;
    assistantMessageId: string;
    parts: MessagePart[];
    timestamp: string;
  }) => void | Promise<void>;
}

const TERMINAL_CHANNELS = new Set(["ai:stream-done", "ai:stream-error"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const readNumber = (
  record: Record<string, unknown>,
  key: string,
): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readToken = (
  record: Record<string, unknown>,
  key: string,
): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readUsage = (value: unknown): SubagentChildView["usage"] | null => {
  if (!isRecord(value)) return null;
  return {
    inputTokens: readToken(value, "inputTokens"),
    outputTokens: readToken(value, "outputTokens"),
    totalTokens: readToken(value, "totalTokens"),
  };
};

const mergeUsage = (
  current: SubagentChildView["usage"],
  next: SubagentChildView["usage"],
): SubagentChildView["usage"] => ({
  inputTokens: next.inputTokens ?? current.inputTokens,
  outputTokens: next.outputTokens ?? current.outputTokens,
  totalTokens:
    next.totalTokens ??
    (next.inputTokens != null || next.outputTokens != null
      ? (next.inputTokens ?? 0) + (next.outputTokens ?? 0)
      : current.totalTokens),
});

const isSubagentStatus = (
  value: unknown,
): value is SubagentChildView["status"] =>
  value === "queued" ||
  value === "running" ||
  value === "ok" ||
  value === "failed" ||
  value === "cancelled" ||
  value === "timeout" ||
  value === "token_limit";

const isSubagentResultQuality = (
  value: unknown,
): value is NonNullable<SubagentChildView["resultQuality"]> =>
  value === "complete" || value === "usable_partial" || value === "no_result";

const toolResultState = (result: unknown): ToolState => {
  const resultObj = isRecord(result) ? result : null;
  const isFailure =
    resultObj != null &&
    (resultObj.success === false || resultObj.isError === true);
  return isFailure ? "output-error" : "output-available";
};

const findSubagentPart = (
  parts: SubagentMessagePart[],
  batchId: string,
): SubagentMessagePart | null =>
  parts.find((part) => part.batchId === batchId) ?? null;

const findSubagentChild = (
  part: SubagentMessagePart | null,
  childTaskId: string,
): SubagentChildView | null =>
  part?.children.find((child) => child.childTaskId === childTaskId) ?? null;

const appendSubagentText = (child: SubagentChildView, delta: string): void => {
  if (child.status === "queued") child.status = "running";
  const parts = child.parts ? [...child.parts] : [];
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else {
    parts.push({ type: "text", text: delta });
  }
  child.parts = parts;
};

const appendSubagentToolCall = (
  child: SubagentChildView,
  input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  },
): void => {
  if (child.status === "queued") child.status = "running";
  const parts = child.parts ? [...child.parts] : [];
  if (
    !parts.some(
      (part) => part.type === "tool" && part.toolCallId === input.toolCallId,
    )
  ) {
    parts.push({
      type: "tool",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      state: "input-available",
    });
  }
  child.parts = parts;
  child.stepCount += 1;
  if (!child.toolCalls.some((tool) => tool.toolCallId === input.toolCallId)) {
    child.toolCalls = [
      ...child.toolCalls,
      {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        state: "input-available",
      },
    ];
  }
};

const applySubagentToolResult = (
  child: SubagentChildView,
  input: { toolCallId: string; result: unknown },
): void => {
  if (child.status === "queued") child.status = "running";
  const state = toolResultState(input.result);
  child.toolCalls = child.toolCalls.map((tool) =>
    tool.toolCallId === input.toolCallId ? { ...tool, state } : tool,
  );
  child.parts = child.parts?.map((part) =>
    part.type === "tool" && part.toolCallId === input.toolCallId
      ? { ...part, result: input.result, state }
      : part,
  );
};

export const buildRecoveredSubagentParts = (
  events: RunEventRecord[],
): MessagePart[] => {
  const parts: SubagentMessagePart[] = [];

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    const batchId = readString(event.payload, "batchId");
    if (!batchId) continue;

    if (event.channel === "ai:subagent-spawn") {
      const toolCallId = readString(event.payload, "toolCallId");
      const concurrency = readNumber(event.payload, "concurrency");
      const childrenInput = Array.isArray(event.payload.children)
        ? event.payload.children
        : [];
      if (!toolCallId || concurrency == null) continue;
      if (findSubagentPart(parts, batchId)) continue;

      const children = childrenInput.flatMap(
        (child, index): SubagentChildView[] => {
          if (!isRecord(child)) return [];
          const childTaskId = readString(child, "childTaskId");
          const goal = readString(child, "goal");
          if (!childTaskId || !goal) return [];
          return [
            {
              childTaskId,
              goal,
              status: index < concurrency ? "running" : "queued",
              stepCount: 0,
              toolCalls: [],
              usage: {
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
              },
            },
          ];
        },
      );

      parts.push({
        type: "subagent",
        batchId,
        toolCallId,
        concurrency,
        children,
      });
      continue;
    }

    const childTaskId = readString(event.payload, "childTaskId");
    if (!childTaskId) continue;
    const child = findSubagentChild(
      findSubagentPart(parts, batchId),
      childTaskId,
    );
    if (!child) continue;

    if (event.channel === "ai:subagent-delta") {
      const delta = readString(event.payload, "delta");
      if (delta) appendSubagentText(child, delta);
      continue;
    }

    if (event.channel === "ai:subagent-tool-call") {
      const toolCallId = readString(event.payload, "toolCallId");
      const toolName = readString(event.payload, "toolName");
      if (!toolCallId || !toolName) continue;
      appendSubagentToolCall(child, {
        toolCallId,
        toolName,
        args: event.payload.args,
      });
      continue;
    }

    if (event.channel === "ai:subagent-tool-result") {
      const toolCallId = readString(event.payload, "toolCallId");
      if (!toolCallId) continue;
      applySubagentToolResult(child, {
        toolCallId,
        result: event.payload.result,
      });
      continue;
    }

    if (event.channel === "ai:subagent-child-usage") {
      const usage = readUsage(event.payload.usage);
      if (usage) {
        if (child.status === "queued") child.status = "running";
        child.usage = mergeUsage(child.usage, usage);
      }
      continue;
    }

    if (event.channel === "ai:subagent-report") {
      const report = event.payload.report;
      if (!isRecord(report)) continue;
      const usage = readUsage(report.usage);
      const status = report.status;
      if (isSubagentStatus(status)) child.status = status;
      const summary = readString(report, "summary");
      if (summary) child.summary = summary;
      const resultQuality = report.resultQuality;
      if (isSubagentResultQuality(resultQuality)) {
        child.resultQuality = resultQuality;
      }
      if (isRecord(report.artifacts)) {
        child.artifacts = report.artifacts;
      }
      const error = readString(report, "error");
      if (error) child.error = error;
      const durationMs = readNumber(report, "durationMs");
      if (durationMs != null) child.durationMs = durationMs;
      if (usage) child.usage = mergeUsage(child.usage, usage);
    }
  }

  return parts;
};

export const recoverInterruptedRunEventLogs = async (
  log: JsonlRunEventLog,
  {
    now = new Date(),
    updateTask,
    appendInterruptedMessage,
    appendRecoveredMessageParts,
  }: RecoveryOptions,
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
    const events = log.readEvents(summary.taskId, 0);
    const recoveredParts = buildRecoveredSubagentParts(events);

    if (
      recoveredParts.length > 0 &&
      summary.sessionId &&
      summary.assistantMessageId
    ) {
      await appendRecoveredMessageParts?.({
        sessionId: summary.sessionId,
        assistantMessageId: summary.assistantMessageId,
        parts: recoveredParts,
        timestamp: completedAt,
      });
    }

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
