import { useI18nContext } from "../../../i18n/i18n-react";
import { getTypeLabel } from "./memory-debug-utils";
import type { EventDistributionItem } from "./useMemoryChartData";

interface Props {
  data: EventDistributionItem[];
}

const SIZE = 100;
const RADIUS = 38;
const STROKE_W = 14;
const CENTER = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const EventDistributionChart = ({ data }: Props) => {
  const { LL } = useI18nContext();

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-30 text-xs text-muted-foreground">
        {LL.memoryDebug_noData()}
      </div>
    );
  }

  const total = data.reduce((acc, d) => acc + d.count, 0);

  // Build segments
  let offset = 0;
  const segments = data.map((d) => {
    const pct = d.count / total;
    const dashLen = pct * CIRCUMFERENCE;
    const dashGap = CIRCUMFERENCE - dashLen;
    const seg = {
      ...d,
      dasharray: `${dashLen} ${dashGap}`,
      dashoffset: -offset,
    };
    offset += dashLen;
    return seg;
  });

  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-24 h-24 shrink-0"
        role="img"
        aria-label={LL.memoryDebug_eventTypes()}
      >
        <title>{LL.memoryDebug_eventTypes()}</title>
        {segments.map((seg) => (
          <circle
            key={seg.type}
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke={seg.color}
            strokeWidth={STROKE_W}
            strokeDasharray={seg.dasharray}
            strokeDashoffset={seg.dashoffset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        ))}
        <text
          x={CENTER}
          y={CENTER}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground text-[14px] font-semibold"
        >
          {total}
        </text>
      </svg>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium text-muted-foreground mb-0.5">
          {LL.memoryDebug_eventTypes()}
        </span>
        {data.map((d) => (
          <div key={d.type} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-sm shrink-0"
              style={{ backgroundColor: d.color }}
            />
            <span className="text-[10px] text-muted-foreground">
              {getTypeLabel(d.type, LL)}
            </span>
            <span className="text-[10px] font-medium text-foreground">
              {d.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
