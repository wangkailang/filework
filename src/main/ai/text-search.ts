/**
 * 文档内 query 检索的文本版(对应 pdf-search 的页版):把一段长文本切成块 →
 * 用 BM25 按 query 给每块打分 → 选最相关的几块、按原文顺序拼装返回。用于
 * webFetch 带 `query` 抓大文章/纯文本时只回相关片段,而不是把全文灌进上下文。
 *
 * 切块策略:先按空行分段,再贪心打包到 ~chunkChars;单段超长(无空行的词表/
 * 巨行)则按定长窗口硬切。纯函数、零依赖,可独立测试。
 */

import { rankBm25 } from "./bm25";

/** 每块目标字符数。 */
const DEFAULT_CHUNK_CHARS = 1_500;
/** 单次最多返回的命中块数,防止命中过多塞满上下文。 */
const DEFAULT_MAX_CHUNKS = 12;
/** 拼装结果的硬字符上限。 */
const DEFAULT_MAX_CHARS = 200_000;
/** 命中块之间的分隔标记(提示中间有省略)。 */
const CHUNK_SEP = "\n\n[…]\n\n";

export interface TextSearchHit {
  /** 命中块按原文顺序拼装。 */
  markdown: string;
  /** 纳入输出的块序号(1-based,原文顺序)。 */
  matchedChunks: number[];
  /** 因块数上限或字符上限丢弃内容时为 true。 */
  truncated: boolean;
}

interface TextSearchOptions {
  chunkChars?: number;
  maxChunks?: number;
  maxChars?: number;
}

/** 把长文本切成块:空行分段 → 贪心打包 → 超长段定长硬切。 */
export function chunkText(
  text: string,
  chunkChars = DEFAULT_CHUNK_CHARS,
): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
  };
  for (const p of paras) {
    if (p.length > chunkChars) {
      flush();
      for (let i = 0; i < p.length; i += chunkChars) {
        chunks.push(p.slice(i, i + chunkChars));
      }
      continue;
    }
    if (buf.length + p.length + 2 > chunkChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  if (chunks.length > 0) return chunks;
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

/**
 * 对长文本做 query 检索。命中(score>0)按相关度取前 maxChunks 块;一块都没命中
 * 则回退到前 3 块。最终按原文顺序拼装,超出 maxChars 再硬截断。
 */
export function searchText(
  text: string,
  query: string,
  opts: TextSearchOptions = {},
): TextSearchHit {
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks = chunkText(text, opts.chunkChars);
  if (chunks.length === 0) {
    return { markdown: "", matchedChunks: [], truncated: false };
  }

  const ranked = rankBm25(chunks, query);
  const hits = ranked.filter((r) => r.score > 0);
  const noMatch = hits.length === 0;
  const pool = noMatch ? ranked.slice(0, 3) : hits;
  const candidateCount = noMatch ? chunks.length : hits.length;

  const chosen = pool.slice(0, maxChunks).map((r) => r.index);
  const ordered = [...chosen].sort((a, b) => a - b);

  let markdown = ordered.map((i) => chunks[i]).join(CHUNK_SEP);
  let truncated = candidateCount > chosen.length;
  if (markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
    truncated = true;
  }

  return {
    markdown,
    matchedChunks: ordered.map((i) => i + 1),
    truncated,
  };
}
