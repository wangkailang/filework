import { describe, expect, it } from "vitest";

import { rankBm25 } from "../bm25";

describe("rankBm25", () => {
  const docs = [
    "the quick brown fox", // 0
    "the lazy dog sleeps", // 1
    "the quick quick fox runs", // 2
  ];

  it("ranks the document with more query-term matches highest", () => {
    const ranked = rankBm25(docs, "quick fox");
    // doc 2 repeats "quick" → higher term frequency than doc 0.
    expect(ranked[0].index).toBe(2);
    expect(ranked[1].index).toBe(0);
  });

  it("gives a zero score to documents containing no query terms", () => {
    const ranked = rankBm25(docs, "quick fox");
    const doc1 = ranked.find((r) => r.index === 1);
    expect(doc1?.score).toBe(0);
    const doc0 = ranked.find((r) => r.index === 0);
    expect((doc0?.score ?? 0) > 0).toBe(true);
  });

  it("returns every document exactly once, sorted by descending score", () => {
    const ranked = rankBm25(docs, "quick fox");
    expect(ranked).toHaveLength(docs.length);
    expect(new Set(ranked.map((r) => r.index)).size).toBe(docs.length);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it("tokenizes case- and punctuation-insensitively", () => {
    const ranked = rankBm25(["Hello, WORLD!", "nothing here"], "world");
    expect(ranked[0].index).toBe(0);
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it("handles empty docs and empty query without throwing", () => {
    expect(rankBm25([], "anything")).toEqual([]);
    const ranked = rankBm25(docs, "");
    expect(ranked).toHaveLength(docs.length);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });
});
