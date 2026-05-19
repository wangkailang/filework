import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
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
    <div className="my-2 rounded-md border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
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
        <div className="px-3 pb-2 pt-1 text-xs font-mono whitespace-pre-wrap text-muted-foreground/90">
          {part.text}
        </div>
      )}
    </div>
  );
}
