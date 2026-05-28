/**
 * PDF 文档内搜索:把 PDF 逐页抽文 → 用 BM25 按 query 给每页打分 → 选出最相关
 * 的几页、按页码序整页拼装返回。相比"头部截断",这是 query 感知的定位,能取到
 * 深处页码上的答案(长 PDF 找具体事实的场景)。
 */

import { rankBm25 } from "./bm25";
import { extractPdfPages, PDF_TEXT_MAX_CHARS, type PdfPage } from "./pdf-text";

// 单次最多返回的命中页数 —— 防止 query 命中太多页时把上下文塞满。
export const PDF_SEARCH_MAX_PAGES = 12;

export interface PdfSearchHit {
  /** 命中页整页文本拼装,每页前缀 `--- Page N ---`。 */
  markdown: string;
  /** 实际纳入输出的页码(升序)。 */
  matchedPages: number[];
  /** 因页数上限或字符上限丢弃了内容时为 true。 */
  truncated: boolean;
}

export type PdfSearchResult =
  | (PdfSearchHit & { ok: true; total: number })
  | { ok: false; error: string };

/**
 * 纯函数:对已抽好的页做 BM25 排序并拼装。命中(score>0)按相关度取前 maxPages
 * 页;若一页都没命中,则回退到前 3 页(总比空手好)。最终按页码升序拼装,阅读
 * 顺序自然;超出 maxChars 再硬截断。
 */
export function assemblePdfSearch(
  pages: PdfPage[],
  query: string,
  maxChars = PDF_TEXT_MAX_CHARS,
  maxPages = PDF_SEARCH_MAX_PAGES,
): PdfSearchHit {
  const ranked = rankBm25(
    pages.map((p) => p.text),
    query,
  );
  const hits = ranked.filter((r) => r.score > 0);
  const noMatch = hits.length === 0;
  const pool = noMatch ? ranked.slice(0, 3) : hits;
  const candidateCount = noMatch ? pages.length : hits.length;

  const chosen = pool.slice(0, maxPages).map((r) => r.index);
  const ordered = [...chosen].sort((a, b) => a - b);

  let markdown = ordered
    .map((i) => `--- Page ${pages[i].num} ---\n${pages[i].text}`)
    .join("\n\n");

  let truncated = candidateCount > chosen.length;
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
    truncated = true;
  }

  return {
    markdown,
    matchedPages: ordered.map((i) => pages[i].num),
    truncated,
  };
}

/** 下载好的 PDF 字节 → 逐页抽文 → BM25 搜索 → 命中整页。 */
export async function searchPdfPages(
  data: Uint8Array,
  query: string,
  maxChars = PDF_TEXT_MAX_CHARS,
): Promise<PdfSearchResult> {
  const extracted = await extractPdfPages(data);
  if (!extracted.ok) return { ok: false, error: extracted.error };
  const hit = assemblePdfSearch(extracted.pages, query, maxChars);
  return { ok: true, total: extracted.total, ...hit };
}
