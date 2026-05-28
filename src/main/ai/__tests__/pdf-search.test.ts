import { describe, expect, it } from "vitest";

import { assemblePdfSearch, searchPdfPages } from "../pdf-search";
import { makeMinimalPdf } from "./pdf-fixtures";

const pages = (texts: string[]) =>
  texts.map((text, i) => ({ num: i + 1, text }));

describe("assemblePdfSearch", () => {
  it("returns only matching pages, in page order, with page headers", () => {
    const r = assemblePdfSearch(
      pages([
        "introduction with nothing relevant",
        "the secret value is 42 apple",
        "some middle filler text",
        "another apple mention here",
      ]),
      "apple",
    );
    expect(r.matchedPages).toEqual([2, 4]);
    expect(r.markdown).toContain("--- Page 2 ---");
    expect(r.markdown).toContain("--- Page 4 ---");
    expect(r.markdown).toContain("secret value is 42");
    expect(r.markdown).not.toContain("middle filler");
  });

  it("caps the number of pages and marks truncated when many pages match", () => {
    const many = pages(Array.from({ length: 6 }, (_, i) => `apple match ${i}`));
    const r = assemblePdfSearch(many, "apple", 100_000, 2);
    expect(r.matchedPages).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("falls back to leading pages when nothing matches", () => {
    const r = assemblePdfSearch(
      pages(["alpha", "bravo", "charlie", "delta", "echo"]),
      "zzznomatch",
    );
    expect(r.matchedPages.length).toBeGreaterThan(0);
    expect(r.matchedPages[0]).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("caps total characters at maxChars and marks truncated", () => {
    const r = assemblePdfSearch(
      pages([`apple ${"x".repeat(500)}`]),
      "apple",
      100,
    );
    expect(r.markdown.length).toBe(100);
    expect(r.truncated).toBe(true);
  });
});

describe("searchPdfPages", () => {
  it("extracts pages then returns the query-matched page", async () => {
    const pdf = makeMinimalPdf([
      "intro alpha",
      "target bravo value",
      "outro charlie",
    ]);
    const r = await searchPdfPages(pdf, "bravo");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.total).toBe(3);
      expect(r.matchedPages).toEqual([2]);
      expect(r.markdown).toContain("bravo");
      expect(r.markdown).toContain("--- Page 2 ---");
    }
  });

  it("returns an error result for a non-PDF buffer", async () => {
    const r = await searchPdfPages(new Uint8Array([1, 2, 3]), "anything");
    expect(r.ok).toBe(false);
  });
});
