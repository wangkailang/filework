import { cn } from "../../lib/utils";

export interface ContextUsage {
  accuracy?: "actual" | "estimated";
  contextWindow?: number | null;
  cumulativeInputTokens?: number | null;
  maxOutputTokens?: number | null;
  tokenBudget: number | null;
  originalTokens: number | null;
  providerNativeCompaction?: {
    applied?: boolean;
    enabled: boolean;
    mode?: string;
    provider?: string;
    reason?: string;
    triggerTokens?: number | null;
  } | null;
  safetyMargin?: number | null;
}

const formatCompactTokens = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "未知";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
};

const usagePercent = (
  used: number | null,
  limit: number | null,
): number | null => {
  if (used == null || limit == null || limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
};

const accuracyText = (usage: ContextUsage | null): string | null =>
  usage?.accuracy === "estimated" ? "估算" : null;

const providerDisplayName = (provider: string | undefined): string => {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    default:
      return provider ?? "Provider";
  }
};

const providerNativeCompactionText = (
  usage: ContextUsage | null,
): string | null => {
  const native = usage?.providerNativeCompaction;
  if (!native?.enabled) return null;
  const status = native.applied ? "已应用" : "已启用";
  return `原生压缩${status}：${providerDisplayName(native.provider)}`;
};

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const buildContextUsageLabel = (usage: ContextUsage | null): string => {
  if (!usage) return "发送后更新";

  const used = usage.originalTokens;
  const limit = usage.contextWindow ?? usage.tokenBudget;
  const percent = usagePercent(used, limit);
  const suffix = accuracyText(usage) ? "（估算）" : "";
  const nativeCompaction = providerNativeCompactionText(usage);
  const cumulative =
    typeof usage.cumulativeInputTokens === "number" &&
    Number.isFinite(usage.cumulativeInputTokens) &&
    usage.cumulativeInputTokens > 0
      ? `；累计输入 ${formatCompactTokens(usage.cumulativeInputTokens)} 标记`
      : "";
  const nativeSuffix = nativeCompaction ? `；${nativeCompaction}` : "";

  if (percent == null) {
    return `已用 ${formatCompactTokens(used)} 标记，共 ${formatCompactTokens(limit)}${suffix}${cumulative}${nativeSuffix}`;
  }

  return `${percent}% 已用${suffix}；已用 ${formatCompactTokens(used)} 标记，共 ${formatCompactTokens(limit)}${cumulative}${nativeSuffix}`;
};

const buildUsageSummary = (usage: ContextUsage | null) => {
  if (!usage) {
    return {
      percentText: "--",
      percentLabel: "已用",
      usedLine: "发送后更新",
      cumulativeLine: null,
    };
  }

  const limit = usage.contextWindow ?? usage.tokenBudget;
  const percent = usagePercent(usage.originalTokens, limit);
  const cumulativeLine =
    typeof usage.cumulativeInputTokens === "number" &&
    Number.isFinite(usage.cumulativeInputTokens) &&
    usage.cumulativeInputTokens > 0
      ? `累计输入 ${formatCompactTokens(usage.cumulativeInputTokens)} 标记`
      : null;
  const nativeCompactionLine = providerNativeCompactionText(usage);
  return {
    percentText: percent == null ? "--" : `${percent}%`,
    percentLabel: "已用",
    usedLine: `已用 ${formatCompactTokens(usage.originalTokens)} 标记，共 ${formatCompactTokens(limit)}`,
    cumulativeLine,
    nativeCompactionLine,
  };
};

export const ContextUsageButton = ({
  usage,
  className,
}: {
  usage: ContextUsage | null;
  className?: string;
}) => {
  const percent = usage
    ? usagePercent(
        usage.originalTokens,
        usage.contextWindow ?? usage.tokenBudget,
      )
    : null;
  const label = buildContextUsageLabel(usage);
  const summary = buildUsageSummary(usage);
  const accuracy = accuracyText(usage);
  const ringPercent = percent ?? 0;
  const ringOffset = RING_CIRCUMFERENCE * (1 - ringPercent / 100);

  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        <svg
          aria-hidden="true"
          className="-rotate-90 h-5 w-5"
          data-context-usage-percent={percent == null ? "unknown" : percent}
          data-context-usage-ring="true"
          viewBox="0 0 20 20"
        >
          <circle
            className="text-muted-foreground/25"
            cx="10"
            cy="10"
            fill="none"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle
            className={cn(
              "text-muted-foreground transition-[stroke-dashoffset] duration-300",
              percent == null && "opacity-45",
            )}
            cx="10"
            cy="10"
            fill="none"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={ringOffset}
            strokeLinecap="round"
            strokeWidth="2"
          />
        </svg>
      </button>
      <span
        data-context-usage-tooltip="true"
        className="pointer-events-none absolute right-0 bottom-full z-50 mb-2 hidden min-w-[150px] rounded-md border border-border/60 bg-popover/95 px-3 py-2.5 text-center text-xs text-popover-foreground shadow-lg backdrop-blur-sm group-hover:block group-focus-within:block"
      >
        {accuracy ? (
          <span className="flex items-center justify-center gap-1.5 text-muted-foreground">
            <span className="rounded-[3px] border border-border/70 px-1 py-0 text-[10px] leading-4 text-muted-foreground">
              {accuracy}
            </span>
          </span>
        ) : null}
        <span className="mt-0.5 block text-sm font-medium tabular-nums">
          {summary.percentText} {summary.percentLabel}
        </span>
        <span className="mt-1 block whitespace-nowrap leading-snug">
          {summary.usedLine}
        </span>
        {summary.cumulativeLine ? (
          <span className="mt-1 block whitespace-nowrap text-muted-foreground leading-snug">
            {summary.cumulativeLine}
          </span>
        ) : null}
        {summary.nativeCompactionLine ? (
          <span className="mt-1 block whitespace-nowrap text-muted-foreground leading-snug">
            {summary.nativeCompactionLine}
          </span>
        ) : null}
      </span>
    </span>
  );
};
