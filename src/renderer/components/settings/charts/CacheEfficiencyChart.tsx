import { useState } from "react";
import { useI18nContext } from "../../../i18n/i18n-react";
import { formatTokens } from "../../../utils/format";
import type { CacheBucket } from "./useMemoryChartData";

interface Props {
  data: CacheBucket[];
}

const CHART_H = 110;
const CHART_W = 360;
const PAD_TOP = 4;
const PAD_BOTTOM = 2;
const BAR_GAP = 2;

const COLORS = {
  "cache-write": "#60a5fa", // blue-400
  "cache-hit": "#4ade80", // green-400
};

export const CacheEfficiencyChart = ({ data }: Props) => {
  const { LL } = useI18nContext();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-30 text-xs text-muted-foreground">
        {LL.memoryDebug_noData()}
      </div>
    );
  }

  const maxTokens = Math.max(...data.map((d) => d.tokens));
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const barWidth = Math.max(
    4,
    (CHART_W - BAR_GAP * (data.length - 1)) / data.length,
  );

  const scaleY = (v: number) => PAD_TOP + usableH - (v / maxTokens) * usableH;

  return (
    <div className="relative">
      <div className="flex items-center gap-3 mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          {LL.memoryDebug_cacheActivity()}
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: COLORS["cache-write"] }}
          />
          <span className="text-[9px] text-muted-foreground">
            {LL.memoryDebug_written()}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: COLORS["cache-hit"] }}
          />
          <span className="text-[9px] text-muted-foreground">
            {LL.memoryDebug_read()}
          </span>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={LL.memoryDebug_cacheActivity()}
      >
        <title>{LL.memoryDebug_cacheActivity()}</title>
        {data.map((d, i) => {
          const x = i * (barWidth + BAR_GAP);
          const h = (d.tokens / maxTokens) * usableH;
          return (
            <rect
              key={`${d.timestamp}-${d.type}`}
              x={x}
              y={scaleY(d.tokens)}
              width={barWidth}
              height={h}
              rx={1}
              fill={COLORS[d.type]}
              opacity={hover === i ? 1 : 0.8}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      {hover !== null && data[hover] && (
        <div
          className="absolute z-10 bg-popover border border-border rounded-md shadow-lg text-xs px-2 py-1 pointer-events-none"
          style={{
            left: `${Math.min((hover / data.length) * 100, 75)}%`,
            top: 20,
          }}
        >
          <div style={{ color: COLORS[data[hover].type] }}>
            {data[hover].type === "cache-write"
              ? LL.memoryDebug_written()
              : LL.memoryDebug_read()}
            : {formatTokens(data[hover].tokens)}
          </div>
        </div>
      )}
    </div>
  );
};
