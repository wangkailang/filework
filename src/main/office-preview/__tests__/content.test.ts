import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { prepareOfficeContentPreview } from "../content";

const requireForTest = createRequire(import.meta.url);
const mammothRequire = createRequire(requireForTest.resolve("mammoth"));
const JSZip = mammothRequire("jszip") as {
  new (): {
    file(path: string, content: string): unknown;
    folder(path: string): { file(path: string, content: string): unknown };
    generateAsync(options: { type: "nodebuffer" }): Promise<Buffer>;
  };
};

const makeTempDir = async () => {
  const root = join(
    tmpdir(),
    `filework-office-content-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  return root;
};

const writeMinimalPptx = async (filePath: string) => {
  const zip = new JSZip();
  zip.file("docProps/app.xml", "<Properties><Slides>2</Slides></Properties>");
  zip.file(
    "ppt/slides/slide1.xml",
    "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p><a:p><a:r><a:t>First milestone</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
  );
  zip.file(
    "ppt/slides/slide2.xml",
    "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Launch &amp; Learn</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
  );
  zip.file(
    "ppt/notesSlides/notesSlide2.xml",
    "<p:notes><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>",
  );
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
};

const writeMinimalDocx = async (filePath: string) => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip
    .folder("_rels")
    .file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
  zip
    .folder("word")
    .file(
      "document.xml",
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Project Brief</w:t></w:r></w:p><w:p><w:r><w:t>Every paragraph remains available.</w:t></w:r></w:p></w:body></w:document>',
    );
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
};

describe("Office content preview", () => {
  let root: string;
  let cacheRoot: string;

  beforeEach(async () => {
    root = await makeTempDir();
    cacheRoot = join(root, "cache");
  });

  it("caches every Excel sheet with tabular preview rows", async () => {
    const workbookPath = join(root, "metrics.xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Score"],
        ["Ada", 42],
      ]),
      "North",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Score"],
        ["Lin", 37],
      ]),
      "South",
    );
    XLSX.writeFile(workbook, workbookPath);

    const first = await prepareOfficeContentPreview(workbookPath, {
      cacheRoot,
    });
    const second = await prepareOfficeContentPreview(workbookPath, {
      cacheRoot,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(first.preview.kind).toBe("spreadsheet");
    if (first.preview.kind !== "spreadsheet") return;
    expect(first.preview.sheets.map((sheet) => sheet.name)).toEqual([
      "North",
      "South",
    ]);
    expect(first.preview.sheets[0].rows).toEqual([
      ["Name", "Score"],
      ["Ada", "42"],
    ]);
    expect(first.preview.sheets[1].rows).toEqual([
      ["Name", "Score"],
      ["Lin", "37"],
    ]);
    expect(second.preview).toEqual(first.preview);
  });

  it("keeps all spreadsheet preview rows instead of truncating sheet data", async () => {
    const workbookPath = join(root, "large.xlsx");
    const workbook = XLSX.utils.book_new();
    const rows = [["Index", "Value"]];
    for (let i = 1; i <= 1005; i++) {
      rows.push([String(i), `Row ${i}`]);
    }
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      "FullData",
    );
    XLSX.writeFile(workbook, workbookPath);

    const result = await prepareOfficeContentPreview(workbookPath, {
      cacheRoot,
    });

    expect(result.preview.kind).toBe("spreadsheet");
    if (result.preview.kind !== "spreadsheet") return;
    const [sheet] = result.preview.sheets;
    expect(sheet.truncated).toBe(false);
    expect(sheet.rows).toHaveLength(1006);
    expect(sheet.rows.at(-1)).toEqual(["1005", "Row 1005"]);
  });

  it("extracts all PPTX slides and notes instead of keeping only a thumbnail", async () => {
    const deckPath = join(root, "deck.pptx");
    await writeMinimalPptx(deckPath);

    const result = await prepareOfficeContentPreview(deckPath, { cacheRoot });

    expect(result.preview.kind).toBe("presentation");
    if (result.preview.kind !== "presentation") return;
    expect(result.preview.slideCount).toBe(2);
    expect(result.preview.slides).toEqual([
      { index: 1, notes: null, text: "Roadmap\nFirst milestone" },
      { index: 2, notes: "Speaker note", text: "Launch & Learn" },
    ]);
  });

  it("converts legacy PPT files to PPTX for full slide content fallback", async () => {
    const deckPath = join(root, "converted.pptx");
    const legacyPath = join(root, "legacy.ppt");
    const fakeLibreOfficePath = join(root, "fake-soffice");
    await writeMinimalPptx(deckPath);
    await writeFile(legacyPath, "legacy ppt bytes");
    await writeFile(
      fakeLibreOfficePath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("LibreOffice 24.2");
  process.exit(0);
}
const outdir = args[args.indexOf("--outdir") + 1];
const input = args[args.length - 1];
const output = path.join(outdir, path.basename(input, path.extname(input)) + ".pptx");
fs.copyFileSync(${JSON.stringify(deckPath)}, output);
`,
    );
    await chmod(fakeLibreOfficePath, 0o755);

    const result = await prepareOfficeContentPreview(legacyPath, {
      cacheRoot,
      libreOfficePath: fakeLibreOfficePath,
    });

    expect(result.preview.kind).toBe("presentation");
    if (result.preview.kind !== "presentation") return;
    expect(result.preview.slideCount).toBe(2);
    expect(result.preview.slides.map((slide) => slide.text)).toEqual([
      "Roadmap\nFirst milestone",
      "Launch & Learn",
    ]);
  });

  it("extracts DOCX text and HTML for document fallback preview", async () => {
    const docPath = join(root, "brief.docx");
    await writeMinimalDocx(docPath);

    const result = await prepareOfficeContentPreview(docPath, { cacheRoot });

    expect(result.preview.kind).toBe("document");
    if (result.preview.kind !== "document") return;
    expect(result.preview.text).toContain("Project Brief");
    expect(result.preview.text).toContain("Every paragraph remains available.");
    expect(result.preview.html).toContain("<p>Project Brief</p>");
  });
});
