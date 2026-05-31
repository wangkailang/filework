/**
 * In-loop context compaction for the agent's tool results.
 *
 * Within ONE user turn, the AI SDK's internal step loop re-sends the whole
 * message list — including every tool result produced so far — to the model
 * on every step. A single big result (a webFetch `raw` body, a command's
 * stdout) therefore costs its size × the number of remaining steps, which is
 * how a "fetch a 4MB word list, then iterate" turn blows past 2M input tokens.
 *
 * This shrinks OLD tool results: the most recent tool message is left intact
 * (the model is usually acting on it right now), while earlier oversized
 * results are replaced with a head+tail excerpt. Parallel tool calls are
 * disabled, so "most recent tool message" == "current step's result". Pure
 * and structure-preserving: only the `output` text shrinks; toolCallId /
 * toolName / message pairing are untouched.
 */

import type { ModelMessage } from "ai";

/** Older tool results are clamped to this many chars (head+tail). */
const DEFAULT_BUDGET_CHARS = 4_000;
const HEAD_FRAC = 0.75;

interface CompactOptions {
  budgetChars?: number;
}

function outputToString(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text" || o.type === "error-text") {
    return typeof o.value === "string" ? o.value : null;
  }
  if (o.type === "json" || o.type === "error-json") {
    try {
      return JSON.stringify(o.value);
    } catch {
      return null;
    }
  }
  return null; // execution-denied / content parts — small, leave alone
}

function clamp(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const head = Math.floor(budget * HEAD_FRAC);
  const tail = budget - head;
  const dropped = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${dropped} chars elided to save context — re-run the tool or grep the file if you need them]…\n${s.slice(-tail)}`;
}

/**
 * Return a compacted copy of `messages`, or `null` when nothing changed.
 * Leaves the last `tool`-role message full; clamps earlier oversized ones.
 */
export function compactToolResults(
  messages: ModelMessage[],
  opts?: CompactOptions,
): ModelMessage[] | null {
  const budget = opts?.budgetChars ?? DEFAULT_BUDGET_CHARS;

  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      lastToolIdx = i;
      break;
    }
  }
  if (lastToolIdx <= 0) return null; // 0 or 1 tool message — nothing older to trim

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== "tool" || i === lastToolIdx || !Array.isArray(m.content)) {
      return m;
    }
    const content = m.content.map((part) => {
      if (
        !part ||
        typeof part !== "object" ||
        (part as { type?: string }).type !== "tool-result"
      ) {
        return part;
      }
      const tr = part as { output: unknown };
      const str = outputToString(tr.output);
      if (str == null || str.length <= budget) return part;
      changed = true;
      return {
        ...tr,
        output: { type: "text" as const, value: clamp(str, budget) },
      };
    });
    return { ...m, content } as ModelMessage;
  });

  return changed ? out : null;
}
