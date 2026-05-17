import { describe, expect, it } from "vitest";

import {
  extractFinalAnswer,
  groupByLevel,
  median,
  normalizeForScoring,
  scoreAnswer,
} from "../scorer";
import type { NormalizedQuestion } from "../types";

// ─── normalizeForScoring ─────────────────────────────────────────────

describe("normalizeForScoring", () => {
  it("lowercases and trims", () => {
    expect(normalizeForScoring("  Hello WORLD  ")).toBe("hello world");
  });

  it("strips surrounding quotes", () => {
    expect(normalizeForScoring(`"answer"`)).toBe("answer");
    expect(normalizeForScoring(`'42'`)).toBe("42");
  });

  it("strips fuzzy quantifier prefixes", () => {
    expect(normalizeForScoring("approximately 100")).toBe("100");
    expect(normalizeForScoring("about 3.14")).toBe("3.14");
    expect(normalizeForScoring("roughly 5 minutes")).toBe("5 minutes");
    expect(normalizeForScoring("more than 50")).toBe("50");
  });

  it("strips thousand separators and currency / percent markers", () => {
    expect(normalizeForScoring("1,234,567")).toBe("1234567");
    expect(normalizeForScoring("$42.00")).toBe("42.00");
    expect(normalizeForScoring("12.5%")).toBe("12.5");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeForScoring("hello   world\nfoo")).toBe("hello world foo");
  });

  it("is idempotent", () => {
    const once = normalizeForScoring("  About 1,234  ");
    expect(normalizeForScoring(once)).toBe(once);
  });
});

// ─── scoreAnswer ─────────────────────────────────────────────────────

describe("scoreAnswer — exact match path", () => {
  it("passes identical strings", () => {
    const r = scoreAnswer("Mercedes Sosa", "Mercedes Sosa");
    expect(r.passed).toBe(true);
    expect(r.matchType).toBe("exact");
  });

  it("passes case-and-whitespace differences", () => {
    const r = scoreAnswer("  mercedes sosa  ", "Mercedes Sosa");
    expect(r.passed).toBe(true);
    expect(r.matchType).toBe("exact");
  });

  it("passes when truth is wrapped in fuzzy quantifier", () => {
    const r = scoreAnswer("42", "approximately 42");
    expect(r.passed).toBe(true);
  });
});

describe("scoreAnswer — numeric path", () => {
  it("passes integers with thousands separators (matches as exact after comma strip)", () => {
    const r = scoreAnswer("1234567", "1,234,567");
    expect(r.passed).toBe(true);
    // Both sides normalise to "1234567" — exact-match path wins before
    // we ever take the numeric branch.
    expect(r.matchType).toBe("exact");
  });

  it("passes floats within 2dp rounding", () => {
    const r = scoreAnswer("3.14", "3.14159");
    expect(r.passed).toBe(true);
    expect(r.matchType).toBe("numeric");
  });

  it("passes a currency-formatted dollar amount", () => {
    const r = scoreAnswer("$42.00", "42");
    expect(r.passed).toBe(true);
  });

  it("fails when numbers are not close", () => {
    expect(scoreAnswer("100", "42").passed).toBe(false);
  });

  it("does NOT take the numeric path when only one side is numeric", () => {
    // "42" parses; "Forty-two" doesn't. Numeric path is skipped, falls
    // through to exact (fails).
    const r = scoreAnswer("42", "Forty-two");
    expect(r.passed).toBe(false);
    expect(r.matchType).toBe("fail");
  });
});

describe("scoreAnswer — list path", () => {
  it("passes when sets match regardless of order", () => {
    const r = scoreAnswer("blue, red, green", "green, red, blue");
    expect(r.passed).toBe(true);
    expect(r.matchType).toBe("list");
  });

  it("supports semicolon and pipe delimiters in the truth", () => {
    expect(scoreAnswer("a, b, c", "c; b; a").passed).toBe(true);
    expect(scoreAnswer("foo, bar", "bar | foo").passed).toBe(true);
  });

  it("fails when one element is missing", () => {
    expect(scoreAnswer("blue, red", "blue, red, green").passed).toBe(false);
  });

  it("fails for an empty predicted list", () => {
    expect(scoreAnswer("", "a, b, c").passed).toBe(false);
    expect(scoreAnswer("   ", "a, b, c").passed).toBe(false);
  });
});

describe("scoreAnswer — failure cases", () => {
  it("fails on null / empty predicted", () => {
    expect(scoreAnswer(null, "anything").passed).toBe(false);
    expect(scoreAnswer("", "anything").passed).toBe(false);
    expect(scoreAnswer("   ", "anything").passed).toBe(false);
  });

  it("fails when no normaliser brings them into alignment", () => {
    expect(scoreAnswer("Beethoven", "Mozart").passed).toBe(false);
  });

  it("ScoreResult always exposes the normalised forms", () => {
    const r = scoreAnswer("$1,234", "1234");
    expect(r.normalizedPredicted).toBe("1234");
    expect(r.normalizedTruth).toBe("1234");
  });
});

// ─── extractFinalAnswer ──────────────────────────────────────────────

describe("extractFinalAnswer", () => {
  it("pulls out the canonical FINAL ANSWER: line", () => {
    const text = `Let me reason through this...\n\nFINAL ANSWER: 42`;
    expect(extractFinalAnswer(text)).toBe("42");
  });

  it("ignores 'FINAL ANSWER' said in body, takes the trailing one", () => {
    const text = `I'll work toward the FINAL ANSWER below.\n\nFINAL ANSWER: actual`;
    expect(extractFinalAnswer(text)).toBe("actual");
  });

  it("is case-insensitive on the sentinel", () => {
    expect(extractFinalAnswer("final answer: x")).toBe("x");
    expect(extractFinalAnswer("Final Answer: y")).toBe("y");
  });

  it("tolerates an em-dash separator", () => {
    expect(extractFinalAnswer("FINAL ANSWER - 42")).toBe("42");
  });

  it("strips surrounding quotes from the answer", () => {
    expect(extractFinalAnswer(`FINAL ANSWER: "Hello"`)).toBe("Hello");
  });

  it("falls back to the last non-empty line when the sentinel is missing", () => {
    const text = `Working through this...\n\nThe answer is 42`;
    expect(extractFinalAnswer(text)).toBe("The answer is 42");
  });

  it("returns null for empty input", () => {
    expect(extractFinalAnswer("")).toBeNull();
    expect(extractFinalAnswer("    ")).toBeNull();
  });
});

// ─── Aggregation helpers ─────────────────────────────────────────────

describe("median", () => {
  it("handles odd-length arrays", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("averages the two middle values for even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 for empty input rather than NaN", () => {
    expect(median([])).toBe(0);
  });

  it("doesn't mutate the input", () => {
    const arr = [3, 1, 2];
    median(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});

describe("groupByLevel", () => {
  const q = (level: 1 | 2 | 3, id: string): NormalizedQuestion => ({
    taskId: id,
    level,
    question: "?",
    groundTruth: "?",
    fileName: null,
  });

  it("groups by level and returns all three levels even when empty", () => {
    const grouped = groupByLevel([q(1, "a"), q(1, "b"), q(3, "c")]);
    expect(grouped[1]).toHaveLength(2);
    expect(grouped[2]).toHaveLength(0);
    expect(grouped[3]).toHaveLength(1);
  });

  it("returns an empty record-of-arrays for empty input", () => {
    const grouped = groupByLevel([]);
    expect(grouped[1]).toEqual([]);
    expect(grouped[2]).toEqual([]);
    expect(grouped[3]).toEqual([]);
  });
});
