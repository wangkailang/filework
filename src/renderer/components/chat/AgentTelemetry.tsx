import { useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";

// Agent 运行状态 —— 与设计系统状态系统一一对应(见 content/spec/design-system.md)
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
  /** 左栏折叠时,为左上角浮动展开按钮预留左侧空间 */
  reserveLeft?: boolean;
}

/**
 * ★ 设计签名:Agent telemetry 状态条 —— 像任务控制台读数。
 * 常驻对话区顶部,把「Agent 在干嘛 / 要不要我批」提成一眼可读的状态。
 * 只显示状态 + 当前动作 + 运行耗时;不堆 token/模型读数。运行态由脉冲灯 + 扫描光体现。
 */
export const AgentTelemetry = ({
  state,
  action,
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
      className={cn(
        "relative flex h-[34px] shrink-0 items-center gap-3.5 overflow-hidden border-b border-border-faint bg-gradient-to-b from-surface to-background pr-16 font-mono text-[11px] tracking-wide",
        // 左栏折叠 → 让开左上角浮动展开按钮;否则正常左内边距
        reserveLeft ? "pl-12" : "pl-3.5",
      )}
    >
      {/* 状态灯 + 状态词 */}
      <span
        className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.07em] transition-colors duration-300"
        style={{ color: meta.color }}
      >
        <span
          className="relative size-[7px] shrink-0 rounded-full transition-colors duration-300"
          style={{ background: meta.color, color: meta.color }}
        >
          {meta.pulse && (
            <span className="absolute inset-[-3px] rounded-full border border-current animate-ping-ring" />
          )}
        </span>
        {stateLabel[state]}
      </span>

      {/* 当前动作 */}
      {action && (
        <span className="min-w-0 truncate text-primary">{action}</span>
      )}

      {/* 右侧:仅保留运行耗时 */}
      {meta.running && (
        <span className="ml-auto tabular-nums text-muted-foreground">
          {timeStr}
        </span>
      )}

      {/* running 扫描光线 */}
      {meta.running && (
        <span className="pointer-events-none absolute bottom-0 left-0 h-px w-[30%] animate-scan bg-gradient-to-r from-transparent via-primary to-transparent" />
      )}
    </div>
  );
};
