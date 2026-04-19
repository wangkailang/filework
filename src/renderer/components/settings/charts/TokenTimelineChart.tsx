import { useState } from "react";
import { useI18nContext } from "../../../i18n/i18n-react";
import { formatTokens } from "../../../utils/format";
import type { TokenTimelinePoint } from "./useMemoryChartData";

interface Props {
  data: TokenTimelinePoint[];
}

const CHART_H = 110;
const CHART_W = 360;
const PAD_TOP = 4;
const PAD_BOTTOM = 2;
const BAR_GAP = 2;

export const TokenTimelineChart = ({ data }: Props) => {
  const { LL } = useI18nContext();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-30 text-xs text-muted-foreground">
        {LL.memoryDebug_noData()}
      </div>
    );
  }

  const maxTokens = Math.max(...data.map((d) => d.originalTokens));
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const barWidth = Math.max(
    4,
    (CHART_W - BAR_GAP * (data.length - 1)) / data.length,
  );

  const scaleY = (v: number) =>
    PAD_TOP + usableH - (v / maxTokens) * usableH;

  return (
    <div className="relative">
      <div className="flex items-center gap-3 mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          {LL.memoryDebug_tokenTimeline()}
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: "rgba(251, 146, 60, 0.3)" }}
          />
          <span className="text-[9px] text-muted-foreground">
            {LL.memoryDebug_original()}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: "#fb923c" }}
          />
          <span className="text-[9px] text-muted-foreground">
            {LL.memoryDebug_compressed()}
          </span>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={LL.memoryDebug_tokenTimeline()}
      >
        <title>{LL.memoryDebug_tokenTimeline()}</title>
        {data.map((d, i) => {
          const x = i * (barWidth + BAR_GAP);
          const origH = (d.originalTokens / maxTokens) * usableH;
          const compH = (d.compressedTokens / maxTokens) * usableH;
          return (
            <g
              key={d.timestamp}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            >
              {/* Original tokens bar */}
              <rect
                x={x}
                y={scaleY(d.originalTokens)}
                width={barWidth}
                height={origH}
                rx={1}
                fill="rgba(251, 146, 60, 0.3)"
              />
              {/* Compressed tokens bar */}
              <rect
                x={x}
                y={scaleY(d.compressedTokens)}
                width={barWidth}
                height={compH}
                rx={1}
                fill="#fb923c"
              />
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hover !== null && data[hover] && (
        <div
          className="absolute z-10 bg-popover border border-border rounded-md shadow-lg text-xs px-2 py-1 pointer-events-none"
          style={{
            left: `${Math.min(
              (hover / data.length) * 100,
              75,
            )}%`,
            top: 20,
          }}
        >
          <div>
            {LL.memoryDebug_original()}: {formatTokens(data[hover].originalTokens)}
          </div>
          <div>
            {LL.memoryDebug_compressed()}: {formatTokens(data[hover].compressedTokens)}
          </div>
          {data[hover].originalTokens > 0 && (
            <div className="text-green-400">
              -
              {Math.round(
                ((data[hover].originalTokens - data[hover].compressedTokens) /
                  data[hover].originalTokens) *
                  100,
              )}
              %
            </div>
          )}
        </div>
      )}
    </div>
  );
};
