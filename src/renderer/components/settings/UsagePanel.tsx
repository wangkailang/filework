import { BarChart3, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { formatTokens } from "../../utils/format";

interface AggregateUsage {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  taskCount: number;
  byProvider: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      taskCount: number;
    }
  >;
  byModel: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      taskCount: number;
    }
  >;
}

interface RecentUsageItem {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelId: string | null;
  provider: string | null;
}

export const UsagePanel = () => {
  const { LL } = useI18nContext();
  const [aggregate, setAggregate] = useState<AggregateUsage | null>(null);
  const [recent, setRecent] = useState<RecentUsageItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [agg, rec] = await Promise.all([
        window.filework.usage.getAggregateUsage(),
        window.filework.usage.getRecentUsage(10),
      ]);
      setAggregate(agg as AggregateUsage);
      setRecent(rec as RecentUsageItem[]);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">{LL.usage_loading()}</span>
      </div>
    );
  }

  if (!aggregate || aggregate.taskCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <BarChart3 className="w-8 h-8 mb-2 opacity-40" />
        <span className="text-sm">{LL.usage_empty()}</span>
      </div>
    );
  }

  const modelEntries = Object.entries(aggregate.byModel).sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens,
  );

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-medium text-foreground">
        {LL.usage_title()}
      </h3>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-xs text-muted-foreground">
            {LL.usage_total()}
          </div>
          <div className="text-lg font-semibold text-foreground">
            {formatTokens(aggregate.totalTokens)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-xs text-muted-foreground">
            {LL.usage_input()}
          </div>
          <div className="text-lg font-semibold text-foreground">
            {formatTokens(aggregate.totalInput)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-xs text-muted-foreground">
            {LL.usage_output()}
          </div>
          <div className="text-lg font-semibold text-foreground">
            {formatTokens(aggregate.totalOutput)}
          </div>
        </div>
      </div>

      {/* By model breakdown */}
      {modelEntries.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">
            {LL.usage_byModel()}
          </span>
          <div className="space-y-1.5">
            {modelEntries.map(([model, stats]) => {
              const pct =
                aggregate.totalTokens > 0
                  ? (stats.totalTokens / aggregate.totalTokens) * 100
                  : 0;
              return (
                <div key={model} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground truncate max-w-[60%]">
                      {model}
                    </span>
                    <span className="text-muted-foreground">
                      {formatTokens(stats.totalTokens)}{" "}
                      {LL.usage_tasks(String(stats.taskCount))}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent usage list */}
      {recent.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">
            {LL.usage_recent()}
          </span>
          <div className="space-y-1">
            {recent.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-md border border-border bg-muted px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1 mr-3">
                  <div className="text-xs text-foreground truncate">
                    {item.prompt}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {item.modelId ?? "-"} ·{" "}
                    {new Date(item.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {item.totalTokens != null
                    ? formatTokens(item.totalTokens)
                    : "-"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
