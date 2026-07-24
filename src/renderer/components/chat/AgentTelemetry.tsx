import { useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";

export type AgentState = "idle" | "running" | "awaiting" | "error";

const STATE_META: Record<
  AgentState,
  { color: string; pulse: boolean; running: boolean }
> = {
  idle: { color: "var(--color-status-idle)", pulse: false, running: false },
  running: { color: "var(--color-status-running)", pulse: true, running: true },
  awaiting: { color: "var(--color-status-await)", pulse: true, running: false },
  error: { color: "var(--color-status-error)", pulse: false, running: false },
};

interface AgentTelemetryProps {
  state: AgentState;
  /** running 时的当前动作(通常是工具名) */
  action?: string | null;
  /** 当前任务标识和标题,让主工作区始终保留任务上下文。 */
  taskId?: string | null;
  taskTitle?: string | null;
  /** 左栏折叠时,为左上角浮动展开按钮预留左侧空间 */
  reserveLeft?: boolean;
}

/**
 * Neutral status strip: keep the agent state visible without turning the whole
 * chat surface into a decorative console.
 */
export const AgentTelemetry = ({
  state,
  action,
  taskId,
  taskTitle,
  reserveLeft,
}: AgentTelemetryProps) => {
  const { LL } = useI18nContext();
  const meta = STATE_META[state];
  // 状态词走 i18n(en 走 CSS uppercase;CJK 原样显示)
  const stateLabel: Record<AgentState, string> = {
    idle: LL.telemetry_idle(),
    running: LL.telemetry_running(),
    awaiting: LL.telemetry_awaiting(),
    error: LL.telemetry_error(),
  };

  // 耗时:进入 running 起计,离开归零
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (state !== "running") {
      startRef.current = null;
      return;
    }
    startRef.current = performance.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startRef.current != null) {
        setElapsed((performance.now() - startRef.current) / 1000);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [state]);
  const timeStr = `${Math.floor(elapsed / 60)}:${Math.floor(elapsed % 60)
    .toString()
    .padStart(2, "0")}`;

  return (
    <div
      data-task-identity={taskId || undefined}
      className={cn(
        "relative flex h-[34px] shrink-0 items-center gap-3.5 overflow-hidden border-b border-border-faint bg-surface pr-16 font-mono text-xs tracking-wide",
        // 左栏折叠 → 让开左上角浮动展开按钮;否则正常左内边距
        reserveLeft ? "pl-16" : "pl-3.5",
      )}
    >
      {/* 状态灯 + 状态词 */}
      <span
        className="flex items-center gap-1.5 font-semibold uppercase leading-none tracking-[0.07em] transition-colors duration-300"
        style={{ color: meta.color }}
      >
        <span
          className="relative size-[7px] shrink-0 rounded-full transition-colors duration-300"
          style={{ background: meta.color, color: meta.color }}
        >
          {meta.pulse && (
            <span className="absolute inset-[-3px] rounded-full border border-current opacity-45 animate-ping-ring" />
          )}
        </span>
        {stateLabel[state]}
      </span>

      {taskTitle && (
        <>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
          <span className="min-w-0 truncate font-sans text-xs font-medium normal-case leading-none tracking-normal text-foreground">
            {taskTitle}
          </span>
        </>
      )}

      {/* 当前动作 */}
      {action && (
        <span className="min-w-0 truncate leading-none text-primary">
          {action}
        </span>
      )}

      {/* 右侧:仅保留运行耗时 */}
      {meta.running && (
        <span className="ml-auto tabular-nums leading-none text-muted-foreground">
          {timeStr}
        </span>
      )}
    </div>
  );
};
