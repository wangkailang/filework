import {
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface MemoryEventDetail {
  originalTokens?: number;
  compressedTokens?: number;
  messagesCompressed?: number;
  summaryTokens?: number;
  summary?: string;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

interface MemoryEvent {
  id: string;
  taskId: string;
  promptSnippet?: string;
  type:
    | "compression-write"
    | "compression-skip"
    | "cache-write"
    | "cache-hit";
  timestamp: string;
  detail: MemoryEventDetail;
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const compressionRatio = (
  original?: number,
  compressed?: number,
): string | null => {
  if (!original || !compressed || original === 0) return null;
  const pct = Math.round(((original - compressed) / original) * 100);
  return `${pct}%`;
};

const TYPE_CONFIG: Record<
  MemoryEvent["type"],
  { label: string; icon: typeof Brain; color: string }
> = {
  "compression-write": {
    label: "Context 压缩",
    icon: Brain,
    color: "text-orange-400",
  },
  "compression-skip": {
    label: "压缩跳过",
    icon: Brain,
    color: "text-muted-foreground",
  },
  "cache-write": {
    label: "Cache 写入",
    icon: Database,
    color: "text-blue-400",
  },
  "cache-hit": {
    label: "Cache 命中",
    icon: Zap,
    color: "text-green-400",
  },
};

const EventRow = ({ event }: { event: MemoryEvent }) => {
  const [expanded, setExpanded] = useState(false);
  const config = TYPE_CONFIG[event.type];
  const Icon = config.icon;
  const d = event.detail;
  const hasExpandable = !!(d.summary);
  const ratio = compressionRatio(d.originalTokens, d.compressedTokens);

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
        <Icon className={`w-3.5 h-3.5 shrink-0 ${config.color}`} />
        <span className={`text-xs font-medium shrink-0 ${config.color}`}>
          {config.label}
        </span>

        {/* Prompt snippet */}
        {event.promptSnippet && (
          <span className="text-[10px] text-muted-foreground truncate max-w-30">
            {event.promptSnippet}
          </span>
        )}

        <span className="flex-1" />

        {/* Metrics inline */}
        {event.type === "compression-write" && d.originalTokens != null && d.compressedTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {formatTokens(d.originalTokens)} → {formatTokens(d.compressedTokens)}
            {ratio && (
              <span className="ml-1 text-green-400">-{ratio}</span>
            )}
            {d.messagesCompressed != null && ` (${d.messagesCompressed} 条)`}
          </span>
        )}
        {event.type === "compression-skip" && d.originalTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {formatTokens(d.originalTokens)} (未超限)
          </span>
        )}
        {event.type === "cache-write" && d.cacheWriteTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            写入 {formatTokens(d.cacheWriteTokens)} tokens
          </span>
        )}
        {event.type === "cache-hit" && d.cacheReadTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            命中 {formatTokens(d.cacheReadTokens)} tokens
          </span>
        )}
        <span className="text-[10px] text-muted-foreground tabular-nums ml-2 shrink-0">
          {formatTime(event.timestamp)}
        </span>
      </button>

      {expanded && d.summary && (
        <div className="px-2.5 pb-2 pt-0">
          <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
            {d.summary}
          </pre>
        </div>
      )}
    </div>
  );
};

export const MemoryDebugPanel = () => {
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const unsubRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.filework.memoryDebug.getEvents(50);
      setEvents(data as MemoryEvent[]);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();

    // Subscribe to real-time memory events
    unsubRef.current = window.filework.memoryDebug.onEvent((data) => {
      const incoming: MemoryEvent = {
        id: crypto.randomUUID(),
        taskId: data.taskId,
        promptSnippet: data.promptSnippet,
        type: data.type,
        timestamp: new Date().toISOString(),
        detail: data.detail as MemoryEventDetail,
      };
      setEvents((prev) => [incoming, ...prev].slice(0, 200));
    });

    return () => {
      unsubRef.current?.();
    };
  }, [load]);

  const handleClear = async () => {
    await window.filework.memoryDebug.clear();
    setEvents([]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">加载调试数据...</span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Brain className="w-8 h-8 mb-2 opacity-40" />
        <span className="text-sm">暂无 Memory 事件</span>
        <span className="text-xs mt-1">
          对话触发 Context 压缩或 Cache 后将显示在这里
        </span>
      </div>
    );
  }

  // Aggregate stats
  const compressionWrites = events.filter(
    (e) => e.type === "compression-write",
  );
  const cacheHits = events.filter((e) => e.type === "cache-hit");
  const totalOriginal = compressionWrites.reduce(
    (acc, e) => acc + (e.detail.originalTokens ?? 0),
    0,
  );
  const totalCompressed = compressionWrites.reduce(
    (acc, e) => acc + (e.detail.compressedTokens ?? 0),
    0,
  );
  const totalSaved = totalOriginal - totalCompressed;
  const avgRatio = compressionRatio(totalOriginal, totalCompressed);
  const totalCacheRead = cacheHits.reduce(
    (acc, e) => acc + (e.detail.cacheReadTokens ?? 0),
    0,
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Memory Debug</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            清除
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-xs text-muted-foreground">压缩次数</div>
          <div className="text-lg font-semibold text-foreground">
            {compressionWrites.length}
          </div>
          {avgRatio && (
            <div className="text-[10px] text-green-400">
              平均压缩率 {avgRatio}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-xs text-muted-foreground">压缩节省</div>
          <div className="text-lg font-semibold text-foreground">
            {totalSaved > 0 ? formatTokens(totalSaved) : "-"}
          </div>
          {totalOriginal > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {formatTokens(totalOriginal)} → {formatTokens(totalCompressed)}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-xs text-muted-foreground">Cache 命中</div>
          <div className="text-lg font-semibold text-foreground">
            {totalCacheRead > 0 ? formatTokens(totalCacheRead) : "-"}
          </div>
          {cacheHits.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {cacheHits.length} 次命中
            </div>
          )}
        </div>
      </div>

      {/* Event list */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          事件日志 ({events.length})
        </span>
        <div className="space-y-1">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      </div>
    </div>
  );
};
