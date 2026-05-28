import { describe, expect, it } from "vitest";

import { extractPdfPages, extractPdfTextFromBuffer } from "../pdf-text";
import { makeMinimalPdf } from "./pdf-fixtures";

describe("extractPdfTextFromBuffer", () => {
  it("extracts text and page count from a PDF buffer", async () => {
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

  it("returns an error result for a non-PDF buffer", async () => {
    const result = await extractPdfTextFromBuffer(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(result.ok).toBe(false);
  });
});

describe("extractPdfPages", () => {
  it("returns text for each page with 1-based page numbers", async () => {
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

  it("returns an error result for a non-PDF buffer", async () => {
    const result = await extractPdfPages(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.ok).toBe(false);
  });
});
