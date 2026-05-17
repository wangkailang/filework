import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../pdf-text", () => ({
  extractPdfText: vi.fn(),
}));

import {
  type AttachmentHistoryEntry,
  buildUserContentWithAttachments,
} from "../attachments";
import { extractPdfText } from "../pdf-text";

const mockedExtract = vi.mocked(extractPdfText);

const mkAttachment = (
  path: string,
  name: string,
  mimeType: string,
  kind: AttachmentHistoryEntry["kind"],
  size = 100,
): AttachmentHistoryEntry => ({
  type: "attachment",
  path,
  name,
  mimeType,
  size,
  kind,
});

describe("buildUserContentWithAttachments", () => {
  let tmpDir: string;
  let imagePath: string;
  let pdfPath: string;
  let textPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "filework-attach-test-"));
    imagePath = join(tmpDir, "shot.png");
    pdfPath = join(tmpDir, "doc.pdf");
    textPath = join(tmpDir, "snippet.ts");
    // PNG magic header + a few bytes — enough to round-trip as image.
    await writeFile(
      imagePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    );
    await writeFile(pdfPath, Buffer.from("%PDF-1.4\nfake pdf bytes\n"));
    await writeFile(textPath, "const x = 1;\nexport { x };\n");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    mockedExtract.mockReset();
  });

  it("returns text-only content when there are no attachments", async () => {
    const out = await buildUserContentWithAttachments("hello", []);
    expect(out).toEqual([{ type: "text", text: "hello" }]);
  });

  it("anthropic: image → image content part, pdf → file content part", async () => {
    const out = await buildUserContentWithAttachments(
      "describe these",
      [
        mkAttachment(imagePath, "shot.png", "image/png", "image"),
        mkAttachment(pdfPath, "doc.pdf", "application/pdf", "pdf"),
      ],
      "anthropic",
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "describe these" });
    expect(out[1].type).toBe("image");
    if (out[1].type === "image") {
      expect(out[1].mediaType).toBe("image/png");
      expect(out[1].image).toBeInstanceOf(Uint8Array);
    }
    expect(out[2].type).toBe("file");
    if (out[2].type === "file") {
      expect(out[2].mediaType).toBe("application/pdf");
    }
    // Anthropic path is binary-native; extractor should not be called.
    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it("openai: pdf is extracted to inline text (no 'not sent' notice)", async () => {
    mockedExtract.mockResolvedValueOnce({
      ok: true,
      text: "Hello PDF body",
      pages: 3,
      truncated: false,
    });

    const out = await buildUserContentWithAttachments(
      "see attached",
      [
        mkAttachment(imagePath, "shot.png", "image/png", "image"),
        mkAttachment(pdfPath, "doc.pdf", "application/pdf", "pdf"),
      ],
      "openai",
    );

    expect(out.filter((p) => p.type === "image")).toHaveLength(1);
    expect(out.filter((p) => p.type === "file")).toHaveLength(0);

    const joined = out
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");

    expect(joined).toMatch(/--- attached PDF: doc\.pdf \(3 pages\) ---/);
    expect(joined).toMatch(/Hello PDF body/);
    expect(joined).toMatch(/--- end PDF: doc\.pdf ---/);
    expect(joined).not.toMatch(/not sent/i);
    expect(joined).not.toMatch(/could not be parsed/i);
    expect(mockedExtract).toHaveBeenCalledWith(pdfPath);
  });

  it("openai: pdf parse failure → notice that warns against filesystem search", async () => {
    mockedExtract.mockResolvedValueOnce({
      ok: false,
      error: "Invalid PDF structure",
    });

    const out = await buildUserContentWithAttachments(
      "summarize",
      [mkAttachment(pdfPath, "doc.pdf", "application/pdf", "pdf")],
      "openai",
    );

    const joined = out
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");

    expect(joined).toMatch(/doc\.pdf/);
    expect(joined).toMatch(/could not be parsed/);
    expect(joined).toMatch(/Invalid PDF structure/);
    expect(joined).toMatch(/do not search the filesystem/);
  });

  it("openai: pdf truncation trailer is included when extractor reports truncated", async () => {
    mockedExtract.mockResolvedValueOnce({
      ok: true,
      text: "x".repeat(80_000),
      pages: 999,
      truncated: true,
    });

    const out = await buildUserContentWithAttachments(
      "",
      [mkAttachment(pdfPath, "big.pdf", "application/pdf", "pdf")],
      "openai",
    );

    const pdfPart = out.find(
      (p) =>
        p.type === "text" &&
        (p as { type: "text"; text: string }).text.includes("big.pdf"),
    ) as { type: "text"; text: string } | undefined;
    expect(pdfPart).toBeDefined();
    expect(pdfPart?.text).toMatch(
      /\[truncated, only the first 80k characters were included\]/,
    );
  });

  it("text/code file is inlined with a delimiter wrapper", async () => {
    const out = await buildUserContentWithAttachments(
      "what does this do?",
      [mkAttachment(textPath, "snippet.ts", "text/x-typescript", "text")],
      "openai",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: "text", text: "what does this do?" });
    const inlined = out[1] as { type: "text"; text: string };
    expect(inlined.type).toBe("text");
    expect(inlined.text).toMatch(/--- file: snippet\.ts/);
    expect(inlined.text).toMatch(/const x = 1;/);
    expect(inlined.text).toMatch(/--- end: snippet\.ts ---/);
  });

  it("missing file → notice appended, others still processed", async () => {
    const out = await buildUserContentWithAttachments(
      "",
      [
        mkAttachment(
          join(tmpDir, "does-not-exist.png"),
          "missing.png",
          "image/png",
          "image",
        ),
        mkAttachment(imagePath, "shot.png", "image/png", "image"),
      ],
      "anthropic",
    );
    expect(out.filter((p) => p.type === "image")).toHaveLength(1);
    const notices = out
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");
    expect(notices).toMatch(/Failed to read attachment "missing\.png"/);
  });

  it("ollama: image dropped with notice; pdf still extracted to inline text", async () => {
    mockedExtract.mockResolvedValueOnce({
      ok: true,
      text: "ollama-visible body",
      pages: 1,
      truncated: false,
    });

    const out = await buildUserContentWithAttachments(
      "compare",
      [
        mkAttachment(imagePath, "shot.png", "image/png", "image"),
        mkAttachment(pdfPath, "doc.pdf", "application/pdf", "pdf"),
      ],
      "ollama",
    );

    expect(out.filter((p) => p.type === "image")).toHaveLength(0);
    expect(out.filter((p) => p.type === "file")).toHaveLength(0);

    const joined = out
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");

    expect(joined).toMatch(/shot\.png/); // image notice
    expect(joined).toMatch(/ollama-visible body/); // pdf extracted text
    expect(joined).toMatch(/--- attached PDF: doc\.pdf/);
  });

  it("empty base text + attachment-only → image part still emitted", async () => {
    const out = await buildUserContentWithAttachments(
      "",
      [mkAttachment(imagePath, "shot.png", "image/png", "image")],
      "anthropic",
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("image");
  });
});
