import { z } from "zod/v4";
import mammoth from "mammoth";
import { readFile } from "node:fs/promises";
import type { Tool } from "ai";
import type { Skill } from "./types";
import { validateFile } from "./file-skill-utils";

const DOCX_EXTENSIONS = [".docx"];

/**
 * Extract text from all children of a mammoth document node recursively.
 */
const extractText = (node: { type: string; children?: any[]; value?: string }): string => {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(extractText).join("");
};

/**
 * Resolve JSZip from mammoth's dependency tree.
 * mammoth bundles jszip internally; we use createRequire to access it.
 */
const loadJSZip = (): any => {
  const { createRequire } = require("node:module");
  const mammothRequire = createRequire(require.resolve("mammoth"));
  return mammothRequire("jszip");
};

/**
 * Parse docProps/core.xml from a DOCX zip to extract metadata fields.
 * Returns null values for any fields that cannot be extracted.
 */
const parseDocxMetadata = async (
  buffer: Buffer,
): Promise<{
  title: string | null;
  author: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
}> => {
  const defaults = { title: null, author: null, createdAt: null, modifiedAt: null };
  try {
    const JSZip = loadJSZip();
    const zip = await JSZip.loadAsync(buffer);
    const coreXmlFile = zip.file("docProps/core.xml");
    if (!coreXmlFile) return defaults;

    const xml: string = await coreXmlFile.async("string");

    const getTag = (tag: string): string | null => {
      const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
      const match = xml.match(regex);
      return match?.[1]?.trim() || null;
    };

    return {
      title: getTag("dc:title"),
      author: getTag("dc:creator"),
      createdAt: getTag("dcterms:created"),
      modifiedAt: getTag("dcterms:modified"),
    };
  } catch {
    return defaults;
  }
};

const readDocxTextTool: Tool = {
  description: "读取 Word 文档的全部纯文本内容",
  inputSchema: z.object({
    path: z.string().describe("DOCX 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, DOCX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const result = await mammoth.extractRawText({ path });
      return { text: result.value };
    } catch (err) {
      return { error: `DOCX 解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

const readDocxStructureTool: Tool = {
  description:
    "读取 Word 文档的结构信息，返回段落列表（每个段落包含文本内容和样式类型，如 Heading1、Normal 等）",
  inputSchema: z.object({
    path: z.string().describe("DOCX 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, DOCX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const paragraphs: Array<{ text: string; style: string }> = [];

      await mammoth.convertToHtml({
        path,
      }, {
        transformDocument: (document: { type: string; children?: any[] }) => {
          if (document.children) {
            for (const child of document.children) {
              if (child.type === "paragraph") {
                const text = extractText(child);
                const style = child.styleName || "Normal";
                paragraphs.push({ text, style });
              }
            }
          }
          return document;
        },
      });

      return { paragraphs };
    } catch (err) {
      return { error: `DOCX 解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

const getDocxMetadataTool: Tool = {
  description: "读取 Word 文档的元数据信息（标题、作者、创建日期、修改日期、段落数、字数）",
  inputSchema: z.object({
    path: z.string().describe("DOCX 文件的绝对路径"),
  }),
  execute: async ({ path: filePath }: { path: string }) => {
    try {
      const validation = await validateFile(filePath, DOCX_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      // Extract text for word/paragraph counts
      const textResult = await mammoth.extractRawText({ path: filePath });
      const text = textResult.value;
      const lines = text.split(/\n/);
      const paragraphCount = lines.filter((line) => line.trim().length > 0).length;
      const wordCount = text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length;

      // Extract metadata from docProps/core.xml
      const buffer = await readFile(filePath);
      const meta = await parseDocxMetadata(buffer);

      return {
        title: meta.title,
        author: meta.author,
        createdAt: meta.createdAt,
        modifiedAt: meta.modifiedAt,
        paragraphs: paragraphCount,
        words: wordCount,
      };
    } catch (err) {
      return {
        error: `DOCX 元数据读取失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const docxProcessor: Skill = {
  id: "docx-processor",
  name: "Word 文档处理",
  description: "提取 Word（.docx）文档的文本、结构和元数据信息",
  keywords: [
    "docx",
    "doc",
    "docx文件",
    "word文件",
    "word文档",
    "word段落",
    "word结构",
    "document text",
    "read word",
    "word content",
    "paragraph",
  ],
  suggestions: [
    "提取这个Word文档的全部文本",
    "分析Word文档的结构和标题层级",
  ],
  tools: {
    readDocxText: readDocxTextTool,
    readDocxStructure: readDocxStructureTool,
    getDocxMetadata: getDocxMetadataTool,
  },
  systemPrompt: `You are executing a WORD DOCUMENT PROCESSING task. Follow this strategy precisely:

## Execution Steps
1. Use \`readDocxStructure\` to read the document's structure (heading hierarchy and paragraph styles).
2. Based on the user's needs:
   - If full text is needed, use \`readDocxText\` to extract the complete plain text content.
   - If structure analysis is needed, use the paragraph list from \`readDocxStructure\` to understand the document layout.
3. Use \`getDocxMetadata\` to retrieve document metadata (title, author, dates, word/paragraph counts) when relevant.
4. Present the extracted content in a structured format.

## Output Format
- Use Markdown formatting for the output.
- Preserve the document's heading hierarchy:
  - Heading1 → # Heading
  - Heading2 → ## Heading
  - Heading3 → ### Heading
  - Normal → regular paragraph text
- For format conversion, use \`writeFile\` to save the result with the naming convention: \`[original_filename]_converted.md\`.

## Rules
- ALWAYS start by reading the document structure to understand the heading hierarchy.
- Use heading styles to reconstruct the document's logical outline.
- When outputting as Markdown, maintain the heading levels and paragraph structure.
- Report document metadata (word count, paragraph count, author) alongside the content when available.
- If metadata fields are unavailable (null), simply omit them from the output rather than showing "unknown".`,
};
