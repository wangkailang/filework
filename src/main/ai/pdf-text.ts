/**
 * Extract PDF text in the main process so non-Anthropic providers can still
 * "see" PDF attachments — they can't accept native file parts, so we degrade
 * to a text part rather than silently dropping the binary (which previously
 * made the model think the attachment was missing and hallucinate filesystem
 * tool calls).
 *
 * Caps output at ~80k characters so a long report doesn't blow the context.
 */

import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

export const PDF_TEXT_MAX_CHARS = 80_000;

export type PdfExtractResult =
  | { ok: true; text: string; pages: number; truncated: boolean }
  | { ok: false; error: string };

export interface PdfPage {
  /** 1-based 页码。 */
  num: number;
  text: string;
}

export type PdfPagesResult =
  | { ok: true; pages: PdfPage[]; total: number }
  | { ok: false; error: string };

/**
 * 逐页抽取 PDF 文本。相比 `extractPdfTextFromBuffer` 返回的拼接全文,这里保留
 * 页边界,供文档内搜索(BM25)按页打分、命中后整页返回。
 */
export async function extractPdfPages(
  data: Uint8Array,
): Promise<PdfPagesResult> {
  try {
    const pdf = new PDFParse({ data });
    try {
      const r = await pdf.getText();
      return {
        ok: true,
        pages: r.pages.map((p) => ({ num: p.num, text: p.text ?? "" })),
        total: r.total,
      };
    } finally {
      await pdf.destroy();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 直接从内存中的 PDF buffer 抽取文本。这是附件路径(从磁盘读)与 webFetch
 *(下载到内存)共用的核心 —— 两者都无需经过临时文件中转。
 */
export async function extractPdfTextFromBuffer(
  data: Uint8Array,
): Promise<PdfExtractResult> {
  try {
    const pdf = new PDFParse({ data });
    try {
      const r = await pdf.getText();
      const full = r.text ?? "";
      const truncated = full.length > PDF_TEXT_MAX_CHARS;
      return {
        ok: true,
        text: truncated ? full.slice(0, PDF_TEXT_MAX_CHARS) : full,
        pages: r.total,
        truncated,
      };
    } finally {
      await pdf.destroy();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function extractPdfText(path: string): Promise<PdfExtractResult> {
  try {
    const buf = await readFile(path);
    return await extractPdfTextFromBuffer(buf);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
