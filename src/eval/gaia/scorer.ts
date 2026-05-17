/**
 * GAIA scorer — normalised exact-match against the dataset's
 * `"Final answer"` string.
 *
 * GAIA's official scorer normalises both sides before comparison so
 * cosmetic differences (case, punctuation, "approximately") don't make
 * a substantively-correct answer fail. We implement three match modes:
 *
 *   - `exact`   — string-equal after normalisation
 *   - `numeric` — both sides parse as a number; equal within 1e-6 or
 *                 when 2dp-rounded
 *   - `list`    — truth contains a list-delimiter (`,` `;` `|`); both
 *                 sides are split, normalised per-element, sorted, and
 *                 compared
 *
 * Pure module — no I/O, no AI-SDK imports, fully unit-testable.
 */

import type { GaiaLevel, NormalizedQuestion } from "./types";

const FUZZ_PREFIXES =
  /^(approximately|about|around|roughly|exactly|nearly|over|under|at least|at most|more than|less than)\s+/i;

/**
 * Lowercase, strip surrounding whitespace + quotes + fuzzy quantifiers,
 * collapse internal whitespace, drop thousand-separators / $ / %.
 *
 * Keeps decimal points and negative signs so numeric parsing still
 * works on the result.
 */
export const normalizeForScoring = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(FUZZ_PREFIXES, "")
    .replace(/[,$%]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const LIST_DELIM = /[,;|]/;

const isListLike = (s: string): boolean => LIST_DELIM.test(s);

const sortJoinList = (s: string): string =>
  s
    .split(LIST_DELIM)
    .map((x) => normalizeForScoring(x))
    .filter((x) => x.length > 0)
    .sort()
    .join(",");

export type MatchType = "exact" | "numeric" | "list" | "fail";

export interface ScoreResult {
  passed: boolean;
  normalizedPredicted: string;
  normalizedTruth: string;
  matchType: MatchType;
}

/**
 * Score a single answer pair. `predicted` may be `null` when extraction
 * from the agent output failed — that always fails the score.
 */
export const scoreAnswer = (
  predicted: string | null,
  truth: string,
): ScoreResult => {
  const nt = normalizeForScoring(truth);
  if (predicted === null || predicted.trim().length === 0) {
    return {
      passed: false,
      normalizedPredicted: "",
      normalizedTruth: nt,
      matchType: "fail",
    };
  }
  const np = normalizeForScoring(predicted);

  if (np === nt) {
    return {
      passed: true,
      normalizedPredicted: np,
      normalizedTruth: nt,
      matchType: "exact",
    };
  }

  // Numeric path — only when BOTH sides parse cleanly as numbers.
  const pn = Number(np);
  const tn = Number(nt);
  if (Number.isFinite(pn) && Number.isFinite(tn) && np !== "" && nt !== "") {
    const close = Math.abs(pn - tn) < 1e-6 || pn.toFixed(2) === tn.toFixed(2);
    return {
      passed: close,
      normalizedPredicted: np,
      normalizedTruth: nt,
      matchType: close ? "numeric" : "fail",
    };
  }

  // List path — truth has a delimiter, compare as sets (sorted).
  if (isListLike(truth)) {
    const sjp = sortJoinList(predicted);
    const sjt = sortJoinList(truth);
    const eq = sjp === sjt && sjt.length > 0;
    return {
      passed: eq,
      normalizedPredicted: sjp,
      normalizedTruth: sjt,
      matchType: eq ? "list" : "fail",
    };
  }

  return {
    passed: false,
    normalizedPredicted: np,
    normalizedTruth: nt,
    matchType: "fail",
  };
};

// ─── Final-answer extraction ─────────────────────────────────────────

const FINAL_ANSWER_RE = /\bFINAL\s*ANSWER\s*[:-]?\s*([\s\S]+?)\s*$/i;

/**
 * Pull "FINAL ANSWER: ..." out of the agent's last text turn.
 *
 * GAIA's recommended protocol is for the agent to terminate every
 * response with that sentinel; the system prompt we hand the agent
 * spells this out. The regex tolerates trailing punctuation / quotes
 * and accepts a few common variants the agent slips into.
 *
 * Returns the raw extracted string (no normalisation — let `scoreAnswer`
 * do that consistently).
 */
export const extractFinalAnswer = (agentText: string): string | null => {
  if (!agentText || agentText.trim().length === 0) return null;
  // Search from the end of the message — the protocol mandates it's the
  // last thing the agent says, and many models repeat the phrase earlier
  // when reasoning aloud.
  const lines = agentText.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(FINAL_ANSWER_RE);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  }
  // Fallback: last non-empty line of the response.
  const tail = lines.reverse().find((l) => l.trim().length > 0);
  return tail ? tail.trim() : null;
};

// ─── Aggregation helpers ─────────────────────────────────────────────

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

/**
 * Group questions by level for `byLevel` summary stats. Returns counts
 * even for levels with zero questions so downstream code can render a
 * stable shape.
 */
export const groupByLevel = (
  questions: NormalizedQuestion[],
): Record<GaiaLevel, NormalizedQuestion[]> => {
  const out: Record<GaiaLevel, NormalizedQuestion[]> = { 1: [], 2: [], 3: [] };
  for (const q of questions) out[q.level].push(q);
  return out;
};
