import { rankBm25 } from "./bm25";

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
  const summary = options.previousSummary?.trim();
  if (!summary) return null;

  const maxChars = Math.max(
    80,
    Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS),
  );
  if (summary.length <= maxChars) {
    return {
      text: summary,
      wasTruncated: false,
      recalledChunks: 0,
    };
  }

  const chunks = splitSummaryChunks(summary);
  if (chunks.length === 0) return null;

  const maxSnippets = Math.max(
    0,
    Math.floor(options.maxSnippets ?? DEFAULT_MAX_SNIPPETS),
  );
  const query = options.query?.trim() ?? "";
  const recalledIndexes = query
    ? rankBm25(
        chunks.map((chunk) => chunk.text),
        query,
      )
        .filter((hit) => hit.score > 0)
        .slice(0, maxSnippets)
        .map((hit) => hit.index)
    : [];

  const selected = new Set<number>();
  selected.add(0);
  for (const index of recalledIndexes) selected.add(index);
  selected.add(chunks.length - 1);

  const selectedChunks = [...selected]
    .sort((a, b) => a - b)
    .map((index) => chunks[index].text);

  return {
    text: fitText(selectedChunks.join("\n"), maxChars),
    wasTruncated: true,
    recalledChunks: recalledIndexes.length,
  };
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
