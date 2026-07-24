import { describe, expect, it } from "vitest";

import { pptxEditor } from "../pptx-editor";
import {
  decodeXmlEntities,
  extractSlideText,
  listSlideAndNotesPaths,
  parsePptxMetaXml,
  pptxProcessor,
} from "../pptx-processor";

// ─── decodeXmlEntities ───────────────────────────────────────────────

describe("decodeXmlEntities", () => {
  it("decodes the five standard entities", () => {
    expect(decodeXmlEntities("a &lt; b &gt; c")).toBe("a < b > c");
    expect(decodeXmlEntities("&quot;hi&quot;")).toBe('"hi"');
    expect(decodeXmlEntities("it&apos;s")).toBe("it's");
    expect(decodeXmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  it("decodes &amp; last so it doesn't double-decode (e.g. &amp;lt;)", () => {
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("is a no-op for text without entities", () => {
    expect(decodeXmlEntities("plain text 你好")).toBe("plain text 你好");
  });
});

// ─── extractSlideText ────────────────────────────────────────────────

describe("extractSlideText", () => {
  it("extracts a single text run", () => {
    const xml = `<p:sld><p:cSld><p:spTree><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`;
    expect(extractSlideText(xml)).toBe("Hello");
  });

  it("joins multiple runs within a paragraph directly (no space inserted)", () => {
    const xml = `<a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p>`;
    expect(extractSlideText(xml)).toBe("Hello world");
  });

  it("puts each paragraph on its own line", () => {
    const xml = `
      <a:p><a:r><a:t>Title</a:t></a:r></a:p>
      <a:p><a:r><a:t>Bullet one</a:t></a:r></a:p>
      <a:p><a:r><a:t>Bullet two</a:t></a:r></a:p>
    `;
    expect(extractSlideText(xml)).toBe("Title\nBullet one\nBullet two");
  });

  it("decodes XML entities inside text runs", () => {
    const xml = `<a:p><a:r><a:t>Tom &amp; Jerry &lt; cat</a:t></a:r></a:p>`;
    expect(extractSlideText(xml)).toBe("Tom & Jerry < cat");
  });

  it("skips empty paragraphs", () => {
    const xml = `
      <a:p><a:r><a:t>Real</a:t></a:r></a:p>
      <a:p><a:r><a:t></a:t></a:r></a:p>
      <a:p><a:r><a:t>   </a:t></a:r></a:p>
      <a:p><a:r><a:t>Tail</a:t></a:r></a:p>
    `;
    expect(extractSlideText(xml)).toBe("Real\nTail");
  });

  it('handles attributes on <a:t> (e.g. xml:space="preserve")', () => {
    const xml = `<a:p><a:r><a:t xml:space="preserve"> spaced </a:t></a:r></a:p>`;
    // The paragraph trim collapses leading/trailing whitespace.
    expect(extractSlideText(xml)).toBe("spaced");
  });

  it("returns empty string for XML without text runs", () => {
    const xml = `<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`;
    expect(extractSlideText(xml)).toBe("");
  });

  it("does not bleed text between paragraphs (per-iteration runRe reset)", () => {
    const xml = `
      <a:p><a:r><a:t>P1-A</a:t></a:r><a:r><a:t>P1-B</a:t></a:r></a:p>
      <a:p><a:r><a:t>P2</a:t></a:r></a:p>
    `;
    expect(extractSlideText(xml)).toBe("P1-AP1-B\nP2");
  });
});

// ─── listSlideAndNotesPaths ──────────────────────────────────────────

describe("listSlideAndNotesPaths", () => {
  it("returns slides in 1-indexed numeric order", () => {
    const out = listSlideAndNotesPaths([
      "ppt/slides/slide10.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/slide1.xml",
    ]);
    expect(out.map((s) => s.index)).toEqual([1, 2, 10]);
  });

  it("pairs notesSlide<N>.xml with slide<N>.xml when present", () => {
    const out = listSlideAndNotesPaths([
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/notesSlides/notesSlide1.xml",
    ]);
    expect(out).toEqual([
      {
        slidePath: "ppt/slides/slide1.xml",
        notesPath: "ppt/notesSlides/notesSlide1.xml",
        index: 1,
      },
      { slidePath: "ppt/slides/slide2.xml", notesPath: null, index: 2 },
    ]);
  });

  it("ignores unrelated archive entries", () => {
    const out = listSlideAndNotesPaths([
      "ppt/slides/slide1.xml",
      "[Content_Types].xml",
      "ppt/theme/theme1.xml",
      "ppt/media/image1.png",
      "docProps/core.xml",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].slidePath).toBe("ppt/slides/slide1.xml");
  });

  it("does NOT match slideLayout / slideMaster files", () => {
    const out = listSlideAndNotesPaths([
      "ppt/slides/slide1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideMasters/slideMaster1.xml",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].slidePath).toBe("ppt/slides/slide1.xml");
  });

  it("returns an empty array when no slides are present", () => {
    expect(listSlideAndNotesPaths([])).toEqual([]);
    expect(listSlideAndNotesPaths(["docProps/core.xml"])).toEqual([]);
  });
});

// ─── parsePptxMetaXml ────────────────────────────────────────────────

const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="..." xmlns:dc="..." xmlns:dcterms="..." xmlns:xsi="...">
  <dc:title>Q3 Roadmap</dc:title>
  <dc:creator>Alice Example</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">2025-03-14T10:25:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2025-04-02T11:30:15Z</dcterms:modified>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="...">
  <Slides>12</Slides>
  <Company>Acme Corp</Company>
</Properties>`;

describe("parsePptxMetaXml", () => {
  it("pulls every documented field from a well-formed core + app pair", () => {
    expect(parsePptxMetaXml(CORE_XML, APP_XML)).toEqual({
      title: "Q3 Roadmap",
      author: "Alice Example",
      createdAt: "2025-03-14T10:25:00Z",
      modifiedAt: "2025-04-02T11:30:15Z",
      slideCount: 12,
      company: "Acme Corp",
    });
  });

  it("returns null for every field when both XMLs are absent", () => {
    expect(parsePptxMetaXml(null, null)).toEqual({
      title: null,
      author: null,
      createdAt: null,
      modifiedAt: null,
      slideCount: null,
      company: null,
    });
  });

  it("treats empty tag bodies as null (not as an empty string)", () => {
    const sparseCore = `<cp:coreProperties><dc:title></dc:title><dc:creator>   </dc:creator></cp:coreProperties>`;
    const meta = parsePptxMetaXml(sparseCore, null);
    expect(meta.title).toBeNull();
    expect(meta.author).toBeNull();
  });

  it("decodes entities in the title and author fields", () => {
    const core = `<cp:coreProperties><dc:title>Tom &amp; Jerry</dc:title><dc:creator>O&apos;Brien</dc:creator></cp:coreProperties>`;
    const meta = parsePptxMetaXml(core, null);
    expect(meta.title).toBe("Tom & Jerry");
    expect(meta.author).toBe("O'Brien");
  });

  it("returns null slideCount for non-numeric or missing Slides tag", () => {
    expect(
      parsePptxMetaXml(null, "<Properties></Properties>").slideCount,
    ).toBeNull();
    expect(
      parsePptxMetaXml(null, "<Properties><Slides>NaN</Slides></Properties>")
        .slideCount,
    ).toBeNull();
  });
});

// ─── Skill metadata sanity ───────────────────────────────────────────

describe("pptxProcessor skill spec", () => {
  it("declares the three documented tools", () => {
    expect(Object.keys(pptxProcessor.tools ?? {}).sort()).toEqual([
      "getPptxMetadata",
      "readPptxSlides",
      "readPptxText",
    ]);
  });

  it("uses a stable id and includes key matching terms", () => {
    expect(pptxProcessor.id).toBe("pptx-processor");
    expect(pptxProcessor.keywords).toContain("pptx");
    expect(pptxProcessor.keywords).toContain("powerpoint");
    expect(pptxProcessor.keywords).toContain("演示文稿");
    expect(pptxProcessor.keywords).toContain("幻灯片");
  });

  it("has a non-empty system prompt with the execution-steps section", () => {
    expect(pptxProcessor.systemPrompt).toContain("Execution Steps");
    expect(pptxProcessor.systemPrompt.length).toBeGreaterThan(100);
  });
});

describe("pptxEditor skill spec", () => {
  it("is a mutating task skill with inspect and edit tools", () => {
    expect(pptxEditor.category).toBe("task");
    expect(Object.keys(pptxEditor.tools ?? {}).sort()).toEqual([
      "editPptxText",
      "inspectPptxObjects",
    ]);
  });

  it("treats a local PPTX selection as an anchored object, not a guessed target", () => {
    expect(pptxEditor.systemPrompt).toContain("<pptx-selection>");
    expect(pptxEditor.systemPrompt).toContain("sourceRevision");
    expect(pptxEditor.systemPrompt).toContain("validate");
  });
});
