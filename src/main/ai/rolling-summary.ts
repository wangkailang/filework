import { rankBm25 } from "./bm25";
import {
  type MemoryVectorChunk,
  rankVectorMemoryChunks,
} from "./memory-vector";

const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_MAX_SNIPPETS = 4;

export interface RollingSummaryContextOptions {
  previousSummary?: string | null;
  /** 当前新增对话或用户请求,用于从旧摘要里召回相关片段。 */
  query?: string | null;
  /** 允许注入摘要器 prompt 的旧摘要字符上限。 */
  maxChars?: number;
  /** 旧摘要过长时,按 query 召回的片段数量。 */
  maxSnippets?: number;
  /** 已持久化的分层记忆块,会参与向量召回。 */
  memoryChunks?: MemoryVectorChunk[] | null;
}

export interface RollingSummaryContext {
  text: string;
  wasTruncated: boolean;
  recalledChunks: number;
}

interface SummaryChunk {
  index: number;
  text: string;
}

export function buildRollingSummaryContext(
  options: RollingSummaryContextOptions,
): RollingSummaryContext | null {
  const summary = options.previousSummary?.trim() ?? "";
  const memoryChunks = normalizeMemoryChunks(options.memoryChunks);
  if (!summary && memoryChunks.length === 0) return null;

  const maxChars = Math.max(
    80,
    Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS),
  );
  if (summary && summary.length <= maxChars) {
    const query = options.query?.trim() ?? "";
    const maxSnippets = Math.max(
      0,
      Math.floor(options.maxSnippets ?? DEFAULT_MAX_SNIPPETS),
    );
    const supplementalChunks = query
      ? rankRecallCandidates(memoryChunks, query)
          .filter((chunk) => !summary.includes(chunk.text))
          .slice(0, maxSnippets)
      : [];
    let text = summary;
    let recalledChunks = 0;
    for (const chunk of supplementalChunks) {
      const candidate = `${text}\n${chunk.text}`;
      if (candidate.length > maxChars) continue;
      text = candidate;
      recalledChunks += 1;
    }
    return {
      text,
      wasTruncated: false,
      recalledChunks,
    };
  }

  const chunks = summary ? splitSummaryChunks(summary) : [];
  if (chunks.length === 0 && memoryChunks.length === 0) return null;

  const maxSnippets = Math.max(
    0,
    Math.floor(options.maxSnippets ?? DEFAULT_MAX_SNIPPETS),
  );
  const query = options.query?.trim() ?? "";
  const recallCandidates = [
    ...chunks.map((chunk) => ({ text: chunk.text })),
    ...memoryChunks,
  ];
  const recalledTexts = query
    ? rankRecallCandidates(recallCandidates, query)
        .slice(0, maxSnippets)
        .map((chunk) => chunk.text)
    : [];

  const selected = new Set<string>();
  if (chunks[0]) selected.add(chunks[0].text);
  for (const text of recalledTexts) selected.add(text);
  if (chunks.at(-1)) selected.add(chunks.at(-1)?.text ?? "");
  selected.delete("");

  const selectedChunks = [...selected];

  return {
    text: fitText(selectedChunks.join("\n"), maxChars),
    wasTruncated: true,
    recalledChunks: recalledTexts.length,
  };
}

export function splitRollingSummaryChunks(summary: string): string[] {
  return splitSummaryChunks(summary).map((chunk) => chunk.text);
}

function splitSummaryChunks(summary: string): SummaryChunk[] {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks: SummaryChunk[] = [];
  let activeHeading = "";

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      activeHeading = line;
      continue;
    }

    chunks.push({
      index: chunks.length,
      text: activeHeading ? `${activeHeading}\n${line}` : line,
    });
  }

  if (chunks.length > 0) return chunks;
  return [{ index: 0, text: summary }];
}

function fitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[已截断]`;
}

function normalizeMemoryChunks(
  chunks: MemoryVectorChunk[] | null | undefined,
): MemoryVectorChunk[] {
  return (chunks ?? [])
    .map((chunk) => ({
      text: chunk.text.trim(),
      embedding: chunk.embedding ?? null,
    }))
    .filter((chunk) => chunk.text.length > 0);
}

function rankRecallCandidates(
  chunks: MemoryVectorChunk[],
  query: string,
): MemoryVectorChunk[] {
  const lexicalRanked = rankBm25(
    chunks.map((chunk) => chunk.text),
    query,
  )
    .filter((hit) => hit.score > 0)
    .map((hit) => chunks[hit.index]);
  if (lexicalRanked.length > 0) return lexicalRanked;

  return rankVectorMemoryChunks(chunks, query).filter(
    (chunk) => chunk.score > 0,
  );
}
