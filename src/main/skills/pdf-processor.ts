import { readFile } from "node:fs/promises";
import type { Tool } from "ai";
import { PDFParse } from "pdf-parse";
import { z } from "zod/v4";
import { validateFile } from "./file-skill-utils";
import type { Skill } from "./types";

const PDF_EXTENSIONS = [".pdf"];

const readPdfTextTool: Tool = {
  description: "读取 PDF 文件的全部文本内容",
  inputSchema: z.object({
    path: z.string().describe("PDF 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, PDF_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const buffer = await readFile(path);
      const pdf = new PDFParse({ data: buffer });
      try {
        const textResult = await pdf.getText();
        return { text: textResult.text, pages: textResult.total };
      } finally {
        await pdf.destroy();
      }
    } catch (err) {
      return {
        error: `PDF 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const readPdfPagesTool: Tool = {
  description: "按页码范围读取 PDF 文件的文本内容",
  inputSchema: z.object({
    path: z.string().describe("PDF 文件的绝对路径"),
    startPage: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("起始页码（从1开始），默认为第1页"),
    endPage: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("结束页码（包含），默认为最后一页"),
  }),
  execute: async ({
    path,
    startPage,
    endPage,
  }: {
    path: string;
    startPage?: number;
    endPage?: number;
  }) => {
    try {
      const validation = await validateFile(path, PDF_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const buffer = await readFile(path);
      const pdf = new PDFParse({ data: buffer });
      try {
        // First get total page count
        const info = await pdf.getInfo();
        const total = info.total;

        const start = startPage ?? 1;
        const end = endPage ?? total;

        if (start > total || end > total) {
          return {
            error: `页码范围超出: PDF 共 ${total} 页，请求范围 ${start}-${end}`,
          };
        }

        // Build partial page array for the requested range
        const pageNumbers = Array.from(
          { length: end - start + 1 },
          (_, i) => start + i,
        );

        const textResult = await pdf.getText({ partial: pageNumbers });
        const pages = textResult.pages.map((p) => ({
          page: p.num,
          text: p.text,
        }));

        return { pages };
      } finally {
        await pdf.destroy();
      }
    } catch (err) {
      return {
        error: `PDF 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const getPdfMetadataTool: Tool = {
  description: "读取 PDF 文件的元数据信息（标题、作者、页数、创建日期）",
  inputSchema: z.object({
    path: z.string().describe("PDF 文件的绝对路径"),
  }),
  execute: async ({ path }: { path: string }) => {
    try {
      const validation = await validateFile(path, PDF_EXTENSIONS);
      if (!validation.valid) return { error: validation.error };

      const buffer = await readFile(path);
      const pdf = new PDFParse({ data: buffer });
      try {
        const info = await pdf.getInfo();
        const dateNode = info.getDateNode();

        return {
          title: info.info?.Title ?? null,
          author: info.info?.Author ?? null,
          pages: info.total,
          createdAt: dateNode.CreationDate?.toISOString() ?? null,
        };
      } finally {
        await pdf.destroy();
      }
    } catch (err) {
      return {
        error: `PDF 元数据读取失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const pdfProcessor: Skill = {
  id: "pdf-processor",
  name: "PDF 文件处理",
  description: "提取 PDF 文件的文本、页面内容和元数据信息",
  keywords: [
    "pdf",
    "PDF",
    "pdf文件",
    "提取pdf",
    "pdf提取",
    "pdf文本",
    "pdf页面",
    "pdf元数据",
    "extract pdf",
    "pdf text",
    "pdf page",
    "pdf metadata",
  ],
  suggestions: ["提取这个PDF文件的全部文本", "读取PDF文件的元数据信息"],
  tools: {
    readPdfText: readPdfTextTool,
    readPdfPages: readPdfPagesTool,
    getPdfMetadata: getPdfMetadataTool,
  },
  systemPrompt: `You are executing a PDF FILE PROCESSING task. Follow this strategy precisely:

## Execution Steps
1. Use \`getPdfMetadata\` to read the PDF file's metadata (title, author, page count, creation date).
2. Based on the user's needs:
   - If full text is needed, use \`readPdfText\` to extract the complete text content.
   - If specific pages are needed, use \`readPdfPages\` with the appropriate page range.
3. Present the extracted content in a structured format.

## Output Format
- Use Markdown formatting for the output.
- Preserve the document's logical structure (headings, paragraphs, lists).
- For tables detected in the text, format them as Markdown tables when possible.
- If the user requests format conversion, use \`writeFile\` to save the result with the naming convention: \`[original_filename]_converted.md\`.

## Rules
- ALWAYS start by reading metadata to understand the document structure.
- For large documents (many pages), suggest reading specific page ranges instead of the full text.
- If text extraction produces garbled output, inform the user that the PDF may contain scanned images rather than text.
- Report the total page count and any relevant metadata alongside the extracted content.
- When outputting as Markdown, maintain heading hierarchy and list formatting.`,
};
