/**
 * PPTX (PowerPoint) processor — closes the GAIA "Open the attached
 * deck. On slide N, what does it say?" gap that the other skills can't
 * handle. PPTX files are ZIP archives containing XML per slide; we
 * reuse the JSZip implementation bundled inside mammoth (same trick
 * `docx-processor` uses for metadata) so this skill adds no new
 * dependency.
 *
 * Three tools:
 *   - readPptxText      — plain text of every slide, concatenated.
 *   - readPptxSlides    — slide-by-slide: text body + speaker notes.
 *   - getPptxMetadata   — title/author/dates/slideCount from
 *                         docProps/core.xml and docProps/app.xml.
 *
 * What we extract:
 *   - All `<a:t>` text runs from each slide's XML (this covers titles,
 *     body placeholders, table cells, text frames in shapes).
 *   - Speaker notes from `ppt/notesSlides/notesSlide<N>.xml`.
 *
 * What we DON'T extract (out of scope for plain-text MVP):
 *   - Chart data (bound to embedded XLSX)
 *   - Image OCR (no image processing here)
 *   - SmartArt structure
 *   - Animations / transitions metadata
 */
import { readFile } from "node:fs/promises";

import type { Tool } from "ai";
import { z } from "zod/v4";

import { validateFile } from "./file-skill-utils";
import type { Skill } from "./types";

const PPTX_EXTENSIONS = [".pptx"];
const MAX_SLIDES = 500;

// ─── JSZip resolver (bundled inside mammoth) ─────────────────────────

type JSZipFile = { async: (kind: "string") => Promise<string> };
type JSZipArchive = {
  file: (path: string) => JSZipFile | null;
  files: Record<string, unknown>;
};
type JSZipModule = {
  loadAsync: (buf: Buffer) => Promise<JSZipArchive>;
};

const loadJSZip = (): JSZipModule => {
  const { createRequire } = require("node:module");
  const mammothRequire = createRequire(require.resolve("mammoth"));
  return mammothRequire("jszip") as JSZipModule;
};

// ─── Pure helpers (exported for unit tests) ──────────────────────────

/**
 * Decode the five XML entities that show up in PowerPoint text runs.
 * PPTX never uses numeric entities for printable ASCII so this is
 * sufficient.
 */
export const decodeXmlEntities = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Extract every `<a:t>...</a:t>` text run from a slide XML body and
 * concatenate them with newlines between paragraphs (each `<a:p>` is
 * a paragraph; runs inside a paragraph are joined directly).
 *
 * Regex-based rather than a full XML parse: we only care about text
 * leaves, and PPTX text runs never contain nested elements.
 */
export const extractSlideText = (xml: string): string => {
  const paragraphs: string[] = [];
  const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let pMatch: RegExpExecArray | null = paraRe.exec(xml);
  while (pMatch !== null) {
    const paraBody = pMatch[1];
    const runs: string[] = [];
    runRe.lastIndex = 0;
    let rMatch: RegExpExecArray | null = runRe.exec(paraBody);
    while (rMatch !== null) {
      runs.push(decodeXmlEntities(rMatch[1]));
      rMatch = runRe.exec(paraBody);
    }
    const para = runs.join("").trim();
    if (para) paragraphs.push(para);
    pMatch = paraRe.exec(xml);
  }
  return paragraphs.join("\n");
};

/**
 * Pick the slide and notes file paths from a JSZip archive's file
 * listing, in 1-indexed slide order. Returns `null`-valued notes for
 * slides that have no corresponding notes file (most decks have notes
 * only on a subset of slides).
 */
export const listSlideAndNotesPaths = (
  fileNames: string[],
): Array<{ slidePath: string; notesPath: string | null; index: number }> => {
  const slides: Array<{ path: string; index: number }> = [];
  const notes = new Map<number, string>();
  for (const name of fileNames) {
    const slideMatch = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (slideMatch) {
      slides.push({ path: name, index: Number(slideMatch[1]) });
      continue;
    }
    const notesMatch = name.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
    if (notesMatch) {
      notes.set(Number(notesMatch[1]), name);
    }
  }
  slides.sort((a, b) => a.index - b.index);
  return slides.map((s) => ({
    slidePath: s.path,
    notesPath: notes.get(s.index) ?? null,
    index: s.index,
  }));
};

interface PptxMeta {
  title: string | null;
  author: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  slideCount: number | null;
  company: string | null;
}

/**
 * Pull metadata from `docProps/core.xml` (title/author/dates) and
 * `docProps/app.xml` (slide count, company). Both files are optional
 * in the spec; any missing field surfaces as `null`.
 */
export const parsePptxMetaXml = (
  coreXml: string | null,
  appXml: string | null,
): PptxMeta => {
  const getTag = (xml: string | null, tag: string): string | null => {
    if (!xml) return null;
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = xml.match(re);
    return m ? decodeXmlEntities(m[1]).trim() || null : null;
  };
  const slideCountStr = getTag(appXml, "Slides");
  const slideCount = slideCountStr ? Number.parseInt(slideCountStr, 10) : null;
  return {
    title: getTag(coreXml, "dc:title"),
    author: getTag(coreXml, "dc:creator"),
    createdAt: getTag(coreXml, "dcterms:created"),
    modifiedAt: getTag(coreXml, "dcterms:modified"),
    slideCount: Number.isFinite(slideCount) ? slideCount : null,
    company: getTag(appXml, "Company"),
  };
};

// ─── Internals ───────────────────────────────────────────────────────

interface ExtractedSlide {
  index: number;
  text: string;
  notes: string | null;
}

const readArchive = async (filePath: string): Promise<JSZipArchive> => {
  const buffer = await readFile(filePath);
  const JSZip = loadJSZip();
  return await JSZip.loadAsync(buffer);
};

const extractAllSlides = async (
  archive: JSZipArchive,
): Promise<ExtractedSlide[]> => {
  const entries = listSlideAndNotesPaths(Object.keys(archive.files)).slice(
    0,
    MAX_SLIDES,
  );
  const out: ExtractedSlide[] = [];
  for (const { slidePath, notesPath, index } of entries) {
    const slideFile = archive.file(slidePath);
    if (!slideFile) continue;
    const xml = await slideFile.async("string");
    const text = extractSlideText(xml);
    let notes: string | null = null;
    if (notesPath) {
      const notesFile = archive.file(notesPath);
      if (notesFile) {
        const notesXml = await notesFile.async("string");
        const notesText = extractSlideText(notesXml);
        notes = notesText || null;
      }
    }
    out.push({ index, text, notes });
  }
  return out;
};

// ─── Tools ───────────────────────────────────────────────────────────

const readPptxTextTool: Tool = {
  description:
    "读取 PowerPoint 演示文稿的全部纯文本内容（按幻灯片顺序拼接，幻灯片之间用 --- 分隔）",
  inputSchema: z.object({
    path: z.string().describe("PPTX 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, PPTX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };
      const archive = await readArchive(path);
      const slides = await extractAllSlides(archive);
      const text = slides
        .map((s) => `# Slide ${s.index}\n${s.text}`)
        .join("\n\n---\n\n");
      return { text, slideCount: slides.length };
    } catch (err) {
      return {
        error: `PPTX 解析失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
};

const readPptxSlidesTool: Tool = {
  description:
    "按幻灯片返回 PowerPoint 内容数组，每项包含 index、text（幻灯片内全部文本）、notes（演讲者备注，若有）",
  inputSchema: z.object({
    path: z.string().describe("PPTX 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, PPTX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };
      const archive = await readArchive(path);
      const slides = await extractAllSlides(archive);
      return { slides, slideCount: slides.length };
    } catch (err) {
      return {
        error: `PPTX 解析失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
};

const getPptxMetadataTool: Tool = {
  description:
    "读取 PowerPoint 演示文稿的元数据（标题、作者、创建/修改日期、幻灯片数、公司）",
  inputSchema: z.object({
    path: z.string().describe("PPTX 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, PPTX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };
      const archive = await readArchive(path);
      const coreFile = archive.file("docProps/core.xml");
      const appFile = archive.file("docProps/app.xml");
      const coreXml = coreFile ? await coreFile.async("string") : null;
      const appXml = appFile ? await appFile.async("string") : null;
      const meta = parsePptxMetaXml(coreXml, appXml);
      return meta;
    } catch (err) {
      return {
        error: `PPTX 元数据读取失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
};

// ─── Skill spec ──────────────────────────────────────────────────────

export const pptxProcessor: Skill = {
  id: "pptx-processor",
  name: "PowerPoint 演示文稿处理",
  description: "提取 PowerPoint（.pptx）幻灯片的文本、演讲者备注和元数据信息",
  keywords: [
    "pptx",
    "ppt",
    "pptx文件",
    "ppt文件",
    "演示文稿",
    "幻灯片",
    "slides",
    "powerpoint",
    "presentation",
    "deck",
    "speaker notes",
    "演讲备注",
  ],
  suggestions: [
    "提取这个 PowerPoint 的全部文本",
    "总结这个演示文稿每张幻灯片的内容",
    "把幻灯片导出为 Markdown",
  ],
  tools: {
    readPptxText: readPptxTextTool,
    readPptxSlides: readPptxSlidesTool,
    getPptxMetadata: getPptxMetadataTool,
  },
  systemPrompt: `You are executing a POWERPOINT PROCESSING task. Follow this strategy precisely:

## Execution Steps
1. Use \`getPptxMetadata\` to get the slide count, title, and author up front when relevant.
2. Use \`readPptxSlides\` when the user asks about a SPECIFIC slide (or wants per-slide breakdown). The result contains \`{ index, text, notes }\` per slide.
3. Use \`readPptxText\` when the user asks for the whole deck content as one block or wants a flat dump.
4. For "summarise the deck" type questions, prefer \`readPptxSlides\` so you can refer to specific slides in your answer.

## Output Format
- Use Markdown formatting for the output.
- When summarising, reference slides by their \`index\` (e.g. "Slide 3 introduces…").
- For conversion to Markdown, use \`writeFile\` with the naming convention \`[original_filename]_converted.md\`.

## Rules
- Chart values, embedded images, and SmartArt diagrams are NOT extracted — only the text shown on slides plus speaker notes. If the user asks about a chart number or an image, say it isn't available in the text extraction.
- If the user asks about speaker notes specifically, check the \`notes\` field on each slide; it may be \`null\` when a slide has none.
- Report slide count and presentation title alongside the content when available.
- Drop \`null\` metadata fields rather than showing "unknown".`,
};
