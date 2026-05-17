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

export async function extractPdfText(path: string): Promise<PdfExtractResult> {
  try {
    const buf = await readFile(path);
    const pdf = new PDFParse({ data: buf });
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
