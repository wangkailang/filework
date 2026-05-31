import { describe, expect, it } from "vitest";

import { chunkText, searchText } from "../text-search";

describe("chunkText", () => {
  it("splits on blank lines and packs paragraphs", () => {
    const text = "alpha para one\n\nbeta para two\n\ngamma para three";
    const chunks = chunkText(text, 1000);
    expect(chunks).toEqual([
      "alpha para one\n\nbeta para two\n\ngamma para three",
    ]);
  });

  it("hard-splits an oversized paragraph (no blank lines)", () => {
    const big = "a".repeat(3500);
    const chunks = chunkText(big, 1000);
    expect(chunks.length).toBe(4); // 1000+1000+1000+500
    expect(chunks[0].length).toBe(1000);
    expect(chunks[3].length).toBe(500);
  });

  it("returns [] for empty/whitespace input", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});

describe("searchText", () => {
  const doc = [
    "Intro paragraph about apples and oranges.",
    "The capital of France is Paris, a famous city.",
    "Bananas are yellow and grow in bunches.",
  ].join("\n\n");

  it("returns only the chunk relevant to the query", () => {
    const hit = searchText(doc, "capital of France Paris", { chunkChars: 80 });
    expect(hit.markdown).toContain("Paris");
    expect(hit.markdown).not.toContain("Bananas");
    expect(hit.matchedChunks.length).toBeGreaterThan(0);
  });

  it("falls back to the first chunks when nothing matches", () => {
    const hit = searchText(doc, "xyzzy nonexistent term", { chunkChars: 80 });
    expect(hit.markdown.length).toBeGreaterThan(0);
    expect(hit.matchedChunks[0]).toBe(1);
  });

  it("preserves original order of matched chunks", () => {
    const hit = searchText(doc, "apples Bananas", { chunkChars: 80 });
    // chunk 1 (apples) should come before chunk 3 (bananas) in output
    const a = hit.markdown.indexOf("apples");
    const b = hit.markdown.indexOf("Bananas");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it("flags truncated when chunks exceed maxChars", () => {
    const many = Array.from({ length: 50 }, (_, i) => `para ${i} word`).join(
      "\n\n",
    );
    const hit = searchText(many, "word", { chunkChars: 20, maxChars: 40 });
    expect(hit.truncated).toBe(true);
    expect(hit.markdown.length).toBeLessThanOrEqual(40);
  });

  it("returns empty for empty text", () => {
    expect(searchText("", "anything")).toEqual({
      markdown: "",
      matchedChunks: [],
      truncated: false,
    });
  });
});
