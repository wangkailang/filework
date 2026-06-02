import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18nContext } from "../../i18n/i18n-react";
import type { ActiveSkillInfo } from "./types";

/**
 * "Working" indicator shown while a turn is in flight. Behaviours the plain
 * spinner lacked:
 *
 *  1. **Hidden while the model is actively producing visible output.** When
 *     text / reasoning is streaming, `signature` changes every delta, which
 *     resets the idle clock — so we render nothing and let the growing text
 *     itself be the feedback.
 *  2. **Context-tiered copy during silence.** When the model goes quiet
 *     (generating the next step — e.g. a large writeFile's input, which in a
 *     buffered-SSE setup arrives in one burst at the very end), the label
 *     escalates with the wait: a brief "思考中" → "正在生成 · 8s" →
 *     "正在生成较长内容 · 1:03", so a long wait reads as progress and
 *     reassurance rather than a possibly-stuck spinner.
 *
 * Note: the timer is wall-clock "time since last visible output", not document
 * content — true per-line write progress needs unbuffered streaming.
 */
const IDLE_THRESHOLD_MS = 700;
const GENERATING_MS = 4_000;
const LONG_MS = 30_000;
const TICK_MS = 400;

/** "8s" under a minute, "1:03" at/over a minute. */
function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function WorkingIndicator({
  active,
  signature,
  retryText,
  planGenerating,
  activeSkill,
}: {
  /** chat.isLoading && not blocked on the user (approval / clarification). */
  active: boolean;
  /** Changes whenever the model emits visible output; resets the idle clock. */
  signature: number;
  /** Full retry line when retrying; forces the indicator visible. */
  retryText?: string | null;
  /** True while a plan is being generated — keeps its dedicated copy. */
  planGenerating?: boolean;
  activeSkill?: ActiveSkillInfo | null;
}) {
  const { LL } = useI18nContext();
  const lastChangeRef = useRef<number>(Date.now());
  const [, force] = useState(0);

  // Reset the idle clock whenever the model produced something visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the change signal; we intentionally stamp time on its change.
  useEffect(() => {
    lastChangeRef.current = Date.now();
    force((n) => n + 1);
  }, [signature]);

  // 新一轮生成开始(active 上升沿)即重置 idle 时钟,然后开始 tick 让计时前进。
  // 不能只靠 signature 重置:静默回合(如 skill-creator 整段生成 skill 文件、
  // 无可见文本输出)signature 始终不变,否则上一轮的计时会在「取消 → 重开」后
  // 被带进新一轮(表现为计时不归零、继续累加)。
  useEffect(() => {
    if (!active) return;
    lastChangeRef.current = Date.now();
    force((n) => n + 1);
    const t = setInterval(() => force((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [active]);

  if (!active) return null;

  const idleMs = Date.now() - lastChangeRef.current;
  // Actively typing → let the streaming text speak for itself.
  if (!retryText && idleMs < IDLE_THRESHOLD_MS) return null;

  const secs = Math.floor(idleMs / 1000);

  // Resolve label + whether to show the elapsed timer for this tier.
  let label: string;
  let showElapsed = true;
  if (planGenerating) {
    label = LL.chat_planGenerating();
  } else if (idleMs >= LONG_MS) {
    label = LL.chat_generatingLong();
  } else if (idleMs >= GENERATING_MS) {
    label = LL.chat_generating();
  } else {
    // Brief pause — likely still "thinking", not yet a long generation.
    label = LL.chat_thinking();
    showElapsed = false;
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-muted-foreground">
      {retryText ? (
        <>
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">{retryText}</span>
        </>
      ) : (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">
            {label}
            {showElapsed && secs >= 2 && (
              <span className="ml-1 text-xs opacity-75 tabular-nums">
                · {formatElapsed(secs)}
              </span>
            )}
          </span>
        </>
      )}
      {activeSkill && (
        <span className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
          <Sparkles className="w-3 h-3" />
          {activeSkill.skillName}
          <span className="text-muted-foreground">({activeSkill.source})</span>
        </span>
      )}
    </div>
  );
}
