import { describe, expect, it } from "vitest";

import {
  classifyKind,
  extFromMime,
  sniffMimeType,
} from "../attachment-handlers";

describe("sniffMimeType", () => {
  it("recognises image extensions", () => {
    expect(sniffMimeType("a.png")).toBe("image/png");
    expect(sniffMimeType("a.JPG")).toBe("image/jpeg");
    expect(sniffMimeType("a.jpeg")).toBe("image/jpeg");
    expect(sniffMimeType("a.webp")).toBe("image/webp");
    expect(sniffMimeType("a.gif")).toBe("image/gif");
  });

  it("recognises modern image extensions for local-file:// round-trip", () => {
    expect(sniffMimeType("a.avif")).toBe("image/avif");
    expect(sniffMimeType("a.heic")).toBe("image/heic");
    expect(sniffMimeType("a.heif")).toBe("image/heif");
    expect(sniffMimeType("a.bmp")).toBe("image/bmp");
    expect(sniffMimeType("a.tiff")).toBe("image/tiff");
    expect(sniffMimeType("a.tif")).toBe("image/tiff");
    expect(sniffMimeType("a.svg")).toBe("image/svg+xml");
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

describe("extFromMime", () => {
  it("maps the image MIMEs the composer accepts", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
  });
  it("maps modern image MIMEs (avif/heic/bmp/tiff/svg)", () => {
    expect(extFromMime("image/avif")).toBe("avif");
    expect(extFromMime("image/heic")).toBe("heic");
    expect(extFromMime("image/heif")).toBe("heif");
    expect(extFromMime("image/bmp")).toBe("bmp");
    expect(extFromMime("image/tiff")).toBe("tiff");
    expect(extFromMime("image/svg+xml")).toBe("svg");
  });
  it("maps pdf", () => {
    expect(extFromMime("application/pdf")).toBe("pdf");
  });
  it("normalizes case and strips ;params before lookup", () => {
    expect(extFromMime("Image/PNG")).toBe("png");
    expect(extFromMime("IMAGE/JPEG")).toBe("jpg");
    expect(extFromMime("image/jpeg; charset=binary")).toBe("jpg");
    expect(extFromMime("APPLICATION/PDF;version=1.7")).toBe("pdf");
  });
  it("falls back to bin for unknown", () => {
    expect(extFromMime("application/x-weird")).toBe("bin");
    expect(extFromMime("")).toBe("bin");
  });
});

describe("classifyKind normalization", () => {
  it("strips MIME parameters before classifying", () => {
    expect(classifyKind("image/png; charset=binary")).toBe("image");
    expect(classifyKind("application/pdf; version=1.7")).toBe("pdf");
  });
  it("lowercases MIME before classifying", () => {
    expect(classifyKind("Image/PNG")).toBe("image");
    expect(classifyKind("Application/PDF")).toBe("pdf");
  });
});
