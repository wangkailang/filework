import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Loader2,
  RefreshCw,
  Scissors,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { formatTokens } from "../../utils/format";
import { CacheEfficiencyChart } from "./charts/CacheEfficiencyChart";
import { EventDistributionChart } from "./charts/EventDistributionChart";
import { getTypeLabel } from "./charts/memory-debug-utils";
import { TokenTimelineChart } from "./charts/TokenTimelineChart";
import type {
  MemoryEvent,
  MemoryEventDetail,
} from "./charts/useMemoryChartData";
import { useMemoryChartData } from "./charts/useMemoryChartData";

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

const TYPE_ICONS: Record<
  MemoryEvent["type"],
  { icon: typeof Brain; color: string }
> = {
  "compression-write": { icon: Brain, color: "text-orange-400" },
  "compression-skip": { icon: Brain, color: "text-muted-foreground" },
  "compression-error": { icon: AlertTriangle, color: "text-red-400" },
  "result-summarize": { icon: FileText, color: "text-purple-400" },
  "truncation-drop": { icon: Scissors, color: "text-amber-400" },
  "cache-write": { icon: Database, color: "text-blue-400" },
  "cache-hit": { icon: Zap, color: "text-green-400" },
};

const EventRow = ({ event }: { event: MemoryEvent }) => {
  const { LL } = useI18nContext();
  const [expanded, setExpanded] = useState(false);
  const config = TYPE_ICONS[event.type];
  const Icon = config.icon;
  const label = getTypeLabel(event.type, LL);
  const d = event.detail;
  const hasExpandable = !!(d.summary || d.error);
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
          {label}
        </span>

        {/* Prompt snippet */}
        {event.promptSnippet && (
          <span className="text-[10px] text-muted-foreground truncate max-w-30">
            {event.promptSnippet}
          </span>
        )}

        <span className="flex-1" />

        {/* Metrics inline */}
        {event.type === "compression-write" &&
          d.originalTokens != null &&
          d.compressedTokens != null && (
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {formatTokens(d.originalTokens)} →{" "}
              {formatTokens(d.compressedTokens)}
              {ratio && <span className="ml-1 text-green-400">-{ratio}</span>}
              {d.messagesCompressed != null &&
                ` ${LL.memoryDebug_messagesCompressed(String(d.messagesCompressed))}`}
            </span>
          )}
        {event.type === "compression-skip" && d.originalTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {formatTokens(d.originalTokens)} {LL.memoryDebug_notOverLimit()}
          </span>
        )}
        {event.type === "cache-write" && d.cacheWriteTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {LL.memoryDebug_cacheWriteTokens(formatTokens(d.cacheWriteTokens))}
          </span>
        )}
        {event.type === "cache-hit" && d.cacheReadTokens != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {LL.memoryDebug_cacheReadTokens(formatTokens(d.cacheReadTokens))}
          </span>
        )}
        {event.type === "compression-error" && (
          <span className="text-[10px] text-red-400 whitespace-nowrap">
            {LL.memoryDebug_compressionErrorShort()}
          </span>
        )}
        {event.type === "result-summarize" && d.resultsSummarized != null && (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {LL.memoryDebug_resultsSummarized(String(d.resultsSummarized))}
          </span>
        )}
        {event.type === "truncation-drop" && d.messagesDropped != null && (
          <span className="text-[10px] text-amber-400 whitespace-nowrap">
            {LL.memoryDebug_messagesDroppedCount(String(d.messagesDropped))}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground tabular-nums ml-2 shrink-0">
          {formatTime(event.timestamp)}
        </span>
      </button>

      {expanded && (d.summary || d.error) && (
        <div className="px-2.5 pb-2 pt-0">
          <pre
            className={`text-[11px] whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto ${d.error ? "text-red-400" : "text-muted-foreground"}`}
          >
            {d.error ?? d.summary}
          </pre>
        </div>
      )}
    </div>
  );
};

export const MemoryDebugPanel = () => {
  const { LL } = useI18nContext();
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCharts, setShowCharts] = useState(true);
  const unsubRef = useRef<(() => void) | null>(null);
  const { tokenTimeline, cacheBuckets, eventDistribution } =
    useMemoryChartData(events);

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

  const { compressionWrites, cacheHits, totalSaved, avgRatio, totalCacheRead } =
    useMemo(() => {
      const cw = events.filter((e) => e.type === "compression-write");
      const ch = events.filter((e) => e.type === "cache-hit");
      const origSum = cw.reduce(
        (acc, e) => acc + (e.detail.originalTokens ?? 0),
        0,
      );
      const compSum = cw.reduce(
        (acc, e) => acc + (e.detail.compressedTokens ?? 0),
        0,
      );
      return {
        compressionWrites: cw,
        cacheHits: ch,
        totalSaved: origSum - compSum,
        avgRatio: compressionRatio(origSum, compSum),
        totalCacheRead: ch.reduce(
          (acc, e) => acc + (e.detail.cacheReadTokens ?? 0),
          0,
        ),
      };
    }, [events]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">{LL.memoryDebug_loading()}</span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Brain className="w-8 h-8 mb-2 opacity-40" />
        <span className="text-sm">{LL.memoryDebug_empty()}</span>
        <span className="text-xs mt-1">{LL.memoryDebug_emptyHint()}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + stat badges */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-foreground">
            {LL.memoryDebug_title()}
          </h3>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-400/10 px-2 py-0.5 text-[10px] font-medium text-orange-400">
              <Brain className="w-3 h-3" />
              {compressionWrites.length}
              {avgRatio && (
                <span className="text-orange-400/70">({avgRatio})</span>
              )}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-400/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
              {totalSaved > 0 ? formatTokens(totalSaved) : "-"}{" "}
              {LL.memoryDebug_savedLabel()}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-green-400/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
              <Zap className="w-3 h-3" />
              {totalCacheRead > 0 ? formatTokens(totalCacheRead) : "-"}
              {cacheHits.length > 0 && (
                <span className="text-green-400/70">
                  ({LL.memoryDebug_hitTimes(String(cacheHits.length))})
                </span>
              )}
            </span>
          </div>
        </div>
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
            {LL.memoryDebug_clear()}
          </button>
        </div>
      </div>

      {/* Visualization */}
      <div>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-2"
          onClick={() => setShowCharts((v) => !v)}
        >
          {showCharts ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          {LL.memoryDebug_visualization()}
        </button>
        {showCharts && (
          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-3 space-y-3">
              <div className="rounded-lg border border-border bg-muted px-3 py-2.5">
                <TokenTimelineChart data={tokenTimeline} />
              </div>
              <div className="rounded-lg border border-border bg-muted px-3 py-2.5">
                <CacheEfficiencyChart data={cacheBuckets} />
              </div>
            </div>
            <div className="col-span-2 rounded-lg border border-border bg-muted px-3 py-2.5 flex items-center justify-center">
              <EventDistributionChart data={eventDistribution} />
            </div>
          </div>
        )}
      </div>

      {/* Event list */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {LL.memoryDebug_eventLog(String(events.length))}
        </span>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      </div>
    </div>
  );
};
