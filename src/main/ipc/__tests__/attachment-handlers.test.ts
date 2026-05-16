import { describe, expect, it } from "vitest";

import { classifyKind, sniffMimeType } from "../attachment-handlers";

describe("sniffMimeType", () => {
  it("recognises image extensions", () => {
    expect(sniffMimeType("a.png")).toBe("image/png");
    expect(sniffMimeType("a.JPG")).toBe("image/jpeg");
    expect(sniffMimeType("a.jpeg")).toBe("image/jpeg");
    expect(sniffMimeType("a.webp")).toBe("image/webp");
    expect(sniffMimeType("a.gif")).toBe("image/gif");
  });

  it("recognises pdf", () => {
    expect(sniffMimeType("doc.pdf")).toBe("application/pdf");
    expect(sniffMimeType("DOC.PDF")).toBe("application/pdf");
  });

  it("recognises common code/text extensions", () => {
    expect(sniffMimeType("a.ts")).toBe("text/x-typescript");
    expect(sniffMimeType("a.py")).toBe("text/x-python");
    expect(sniffMimeType("a.md")).toBe("text/markdown");
    expect(sniffMimeType("a.json")).toBe("application/json");
  });

  it("falls back to octet-stream for unknown", () => {
    expect(sniffMimeType("strange.xyz")).toBe("application/octet-stream");
    expect(sniffMimeType("noext")).toBe("application/octet-stream");
  });

  it("uses text/plain for known plain-text-ish but unmapped extensions", () => {
    expect(sniffMimeType("server.log")).toBe("text/plain");
    expect(sniffMimeType("data.csv")).toBe("text/plain");
  });
});

describe("classifyKind", () => {
  it("image/* → image", () => {
    expect(classifyKind("image/png")).toBe("image");
    expect(classifyKind("image/jpeg")).toBe("image");
  });
  it("application/pdf → pdf", () => {
    expect(classifyKind("application/pdf")).toBe("pdf");
  });
  it("everything else → text", () => {
    expect(classifyKind("text/plain")).toBe("text");
    expect(classifyKind("text/x-typescript")).toBe("text");
    expect(classifyKind("application/json")).toBe("text");
    expect(classifyKind("application/octet-stream")).toBe("text");
  });
});
