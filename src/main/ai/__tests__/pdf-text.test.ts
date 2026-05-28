import { describe, expect, it } from "vitest";

import { extractPdfPages, extractPdfTextFromBuffer } from "../pdf-text";
import { makeMinimalPdf } from "./pdf-fixtures";

describe("extractPdfTextFromBuffer", () => {
  it("从 PDF buffer 抽取文本与页数", async () => {
    const result = await extractPdfTextFromBuffer(
      makeMinimalPdf(["Hello PDF"]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("Hello");
      expect(result.pages).toBe(1);
      expect(result.truncated).toBe(false);
    }
  });

  it("非 PDF buffer 返回错误结果", async () => {
    const result = await extractPdfTextFromBuffer(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(result.ok).toBe(false);
  });
});

describe("extractPdfPages", () => {
  it("返回每页文本及从 1 开始的页码", async () => {
    const result = await extractPdfPages(
      makeMinimalPdf(["Alpha page", "Bravo page"]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(2);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].num).toBe(1);
      expect(result.pages[1].num).toBe(2);
      expect(result.pages[0].text).toContain("Alpha");
      expect(result.pages[1].text).toContain("Bravo");
    }
  });

  it("非 PDF buffer 返回错误结果", async () => {
    const result = await extractPdfPages(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.ok).toBe(false);
  });
});
