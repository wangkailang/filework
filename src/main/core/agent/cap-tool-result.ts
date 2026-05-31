/**
 * Universal source-side cap on a tool's return value, applied at the
 * ToolRegistry boundary so NO tool (built-in, web, MCP, future) can put an
 * unbounded blob into the model context in the step that consumes it.
 *
 * This complements the per-step compaction (`compact-tool-results.ts`, which
 * shrinks OLDER results on resend): together, the current result is ≤ ceiling
 * and older ones ≤ a few KB, so context is bounded regardless of tool.
 *
 * Strategy: recursively clamp every string field (head+tail), preserving the
 * result's structure/keys so the model still gets a usable shape. As a last
 * resort for pathological array-heavy results (e.g. thousands of tiny
 * segments), if the serialized whole still exceeds a hard ceiling, fall back
 * to a single truncated string. Pure and side-effect free.
 */

/** Per-string field cap. Generous — only runaway text fields hit it. */
const DEFAULT_PER_STRING = 200_000;
/** Hard ceiling on the serialized result; last-resort whole-blob truncate. */
const DEFAULT_CEILING = 400_000;
const HEAD_FRAC = 0.75;

function truncString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const marker = (n: number) => `\n…[truncated ${n} chars]…\n`;
  // Reserve room for the marker so the result stays within `cap`.
  const budget = Math.max(0, cap - marker(s.length).length);
  const head = Math.floor(budget * HEAD_FRAC);
  const tail = budget - head;
  const dropped = s.length - head - tail;
  const out = `${s.slice(0, head)}${marker(dropped)}${s.slice(s.length - tail)}`;
  return out.length <= cap ? out : out.slice(0, cap);
}

/** Returns the SAME reference when nothing was clamped (no needless alloc). */
function clampStrings(value: unknown, perString: number): unknown {
  if (typeof value === "string") {
    return value.length > perString ? truncString(value, perString) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const c = clampStrings(v, perString);
      if (c !== v) changed = true;
      return c;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      const c = clampStrings(rec[k], perString);
      if (c !== rec[k]) changed = true;
      out[k] = c;
    }
    return changed ? out : value;
  }
  return value;
}

export function capToolResult(
  result: unknown,
  opts?: { perString?: number; ceiling?: number },
): unknown {
  const perString = opts?.perString ?? DEFAULT_PER_STRING;
  const ceiling = opts?.ceiling ?? DEFAULT_CEILING;
  if (result == null) return result;
  if (typeof result !== "object" && typeof result !== "string") return result;

  const clamped = clampStrings(result, perString);
  if (typeof clamped === "string") return truncString(clamped, ceiling);

  // Last-resort total bound (covers array-heavy results clampStrings can't shrink).
  try {
    const serialized = JSON.stringify(clamped);
    if (serialized != null && serialized.length > ceiling) {
      return truncString(serialized, ceiling);
    }
  } catch {
    // Circular / non-serializable — leave the per-field clamp as-is.
  }
  return clamped;
}
