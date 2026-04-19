import { useMemo } from "react";
import type {
  MemoryEvent,
  MemoryEventDetail,
  MemoryEventType,
} from "../../../../shared/memory-types";

export type { MemoryEvent, MemoryEventDetail, MemoryEventType };

export interface TokenTimelinePoint {
  timestamp: string;
  originalTokens: number;
  compressedTokens: number;
}

export interface CacheBucket {
  timestamp: string;
  type: "cache-write" | "cache-hit";
  tokens: number;
}

export interface EventDistributionItem {
  type: MemoryEventType;
  count: number;
  color: string;
}

const TYPE_COLORS: Record<MemoryEventType, string> = {
  "compression-write": "#fb923c", // orange-400
  "compression-skip": "#a1a1aa", // zinc-400
  "compression-error": "#f87171", // red-400
  "result-summarize": "#c084fc", // purple-400
  "truncation-drop": "#fbbf24", // amber-400
  "cache-write": "#60a5fa", // blue-400
  "cache-hit": "#4ade80", // green-400
};

export function useMemoryChartData(events: MemoryEvent[]) {
  const tokenTimeline = useMemo<TokenTimelinePoint[]>(() => {
    return events
      .filter(
        (e) =>
          e.type === "compression-write" &&
          e.detail.originalTokens != null &&
          e.detail.compressedTokens != null,
      )
      .reverse() // oldest first for timeline
      .map((e) => ({
        timestamp: e.timestamp,
        originalTokens: e.detail.originalTokens ?? 0,
        compressedTokens: e.detail.compressedTokens ?? 0,
      }));
  }, [events]);

  const cacheBuckets = useMemo<CacheBucket[]>(() => {
    return events
      .filter(
        (e) =>
          (e.type === "cache-write" && e.detail.cacheWriteTokens != null) ||
          (e.type === "cache-hit" && e.detail.cacheReadTokens != null),
      )
      .reverse()
      .map((e) => ({
        timestamp: e.timestamp,
        type: e.type as "cache-write" | "cache-hit",
        tokens:
          e.type === "cache-write"
            ? (e.detail.cacheWriteTokens ?? 0)
            : (e.detail.cacheReadTokens ?? 0),
      }));
  }, [events]);

  const eventDistribution = useMemo<EventDistributionItem[]>(() => {
    const counts = new Map<MemoryEventType, number>();
    for (const e of events) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({
        type,
        count,
        color: TYPE_COLORS[type],
      }))
      .sort((a, b) => b.count - a.count);
  }, [events]);

  return { tokenTimeline, cacheBuckets, eventDistribution };
}
