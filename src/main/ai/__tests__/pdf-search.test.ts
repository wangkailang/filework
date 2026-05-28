import { describe, expect, it } from "vitest";

import { assemblePdfSearch, searchPdfPages } from "../pdf-search";
import { makeMinimalPdf } from "./pdf-fixtures";

const pages = (texts: string[]) =>
  texts.map((text, i) => ({ num: i + 1, text }));

describe("assemblePdfSearch", () => {
  it("只返回命中页,按页码顺序,并带页码标头", () => {
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

  it("命中页过多时限制页数并标记 truncated", () => {
    const many = pages(Array.from({ length: 6 }, (_, i) => `apple match ${i}`));
    const r = assemblePdfSearch(many, "apple", 100_000, 2);
    expect(r.matchedPages).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("无命中时回退到靠前若干页", () => {
    const r = assemblePdfSearch(
      pages(["alpha", "bravo", "charlie", "delta", "echo"]),
      "zzznomatch",
    );
    expect(r.matchedPages.length).toBeGreaterThan(0);
    expect(r.matchedPages[0]).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("总字符超过 maxChars 时截断并标记 truncated", () => {
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
  it("先抽页再返回 query 命中的页", async () => {
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

  it("非 PDF buffer 返回错误结果", async () => {
    const r = await searchPdfPages(new Uint8Array([1, 2, 3]), "anything");
    expect(r.ok).toBe(false);
  });
});
