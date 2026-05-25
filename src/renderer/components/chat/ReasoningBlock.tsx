import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { ReasoningPart } from "./types";

interface Props {
  part: ReasoningPart;
}

/**
 * Collapsible "thinking" block for reasoning-capable models (o-series,
 * DeepSeek-Reasoner, Claude extended thinking).
 *
 * Defaults to **collapsed when done** (the user has the final answer below
 * and reasoning is usually noisy) and **expanded while streaming** (so the
 * user can watch the model think).
 */
export function ReasoningBlock({ part }: Props) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const streaming = !part.done;
  const open = manualOpen ?? streaming;

  return (
    <div
      className={cn(
        // 收起态:无边框单行;展开态:才成卡片
        "rounded-md transition-colors",
        open && "border border-border/60 bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        {streaming ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Brain className="h-3.5 w-3.5" />
        )}
        <span className="font-medium">
          {streaming ? "Thinking…" : "Reasoning"}
        </span>
        <span className="ml-auto">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-1 text-xs font-mono whitespace-pre-wrap text-muted-foreground/90">
          {part.text}
        </div>
      )}
    </div>
  );
}
