import {
  Activity,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";

type TraceEvent = {
  id: string;
  taskId: string;
  type: string;
  timestamp: string;
  toolCallId?: string | null;
  toolName?: string | null;
  detail: Record<string, unknown>;
};

type TaskSummary = {
  taskId: string;
  createdAt: string;
  summary: string;
  originalTokens?: number | null;
  compressedTokens?: number | null;
  summaryTokens?: number | null;
};

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const labelFor = (type: string): string => {
  switch (type) {
    case "task-start":
      return "Task start";
    case "model-selected":
      return "Model selected";
    case "skill-activated":
      return "Skill activated";
    case "retry":
      return "Retry";
    case "task-done":
      return "Task done";
    case "task-failed":
      return "Task failed";
    case "task-aborted":
      return "Task aborted";
    case "tool-start":
      return "Tool start";
    case "tool-end":
      return "Tool end";
    case "tool-error":
      return "Tool error";
    default:
      return type;
  }
};

const EventRow = ({ event }: { event: TraceEvent }) => {
  const [expanded, setExpanded] = useState(false);
  const hasExpandable = Object.keys(event.detail ?? {}).length > 0;
  const label = labelFor(event.type);

  return (
    <div className="rounded-md border border-border bg-muted">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => hasExpandable && setExpanded((v) => !v)}
      >
        {hasExpandable ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Activity className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground shrink-0">
          {label}
        </span>
        {event.toolName && (
          <span className="text-[10px] text-muted-foreground truncate max-w-40">
            {event.toolName}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] text-muted-foreground tabular-nums ml-2 shrink-0">
          {formatTime(event.timestamp)}
        </span>
      </button>

      {expanded && hasExpandable && (
        <div className="px-2.5 pb-2 pt-0">
          <pre className="text-[11px] whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto text-muted-foreground">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

export const TaskTracePanel = () => {
  const { LL } = useI18nContext();
  const [taskId, setTaskId] = useState("");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    if (!taskId.trim()) return;
    setLoading(true);
    try {
      const [data, s] = await Promise.all([
        window.filework.taskTrace.getEvents(taskId.trim(), 200),
        window.filework.taskTrace.getSummary(taskId.trim()),
      ]);
      const rows = (data as TraceEvent[]).slice().sort((a, b) => {
        return a.timestamp.localeCompare(b.timestamp);
      });
      setEvents(rows);
      setSummary((s as TaskSummary | null) ?? null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    unsubRef.current = window.filework.taskTrace.onEvent((data) => {
      const current = taskId.trim();
      if (!current) return;
      if (data.taskId !== current) return;
      const incoming: TraceEvent = {
        id: crypto.randomUUID(),
        taskId: data.taskId,
        type: data.type,
        timestamp: data.timestamp,
        toolCallId: data.toolCallId ?? null,
        toolName: data.toolName ?? null,
        detail: (data.detail ?? {}) as Record<string, unknown>,
      };
      setEvents((prev) =>
        [...prev, incoming].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp),
        ),
      );
    });
    return () => unsubRef.current?.();
  }, [taskId]);

  const title = useMemo(() => "Task Trace", []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          {LL.memoryDebug_clear?.() ? "Refresh" : "Refresh"}
        </button>
      </div>

      {summary?.summary ? (
        <div className="rounded-lg border border-border bg-muted px-3 py-2.5">
          <div className="text-xs font-medium text-muted-foreground">
            Durable summary
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 whitespace-pre-wrap max-h-32 overflow-y-auto">
            {summary.summary}
          </div>
          <div className="text-[10px] text-muted-foreground mt-2">
            {new Date(summary.createdAt).toLocaleString()}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <label
          htmlFor="task-trace-task-id"
          className="text-xs font-medium text-muted-foreground"
        >
          Task ID
        </label>
        <input
          id="task-trace-task-id"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="button"
          onClick={load}
          disabled={!taskId.trim()}
          className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading
            </span>
          ) : (
            "Load"
          )}
        </button>
      </div>

      {events.length > 0 ? (
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Enter a Task ID to view its trace events.
        </div>
      )}
    </div>
  );
};
