const DEFAULT_DIMENSIONS = 256;

export interface MemoryVectorChunk {
  text: string;
  embedding?: number[] | null;
}

export interface RankedMemoryChunk extends MemoryVectorChunk {
  score: number;
}

export function embedTextToVector(
  text: string,
  dimensions = DEFAULT_DIMENSIONS,
): number[] {
  const size = Math.max(16, Math.floor(dimensions));
  const vector = new Array<number>(size).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % size;
    vector[index] += hash & 1 ? 1 : -1;
  }

  return normalizeVector(vector);
}

export function rankVectorMemoryChunks(
  chunks: MemoryVectorChunk[],
  query: string,
): RankedMemoryChunk[] {
  const queryVector = embedTextToVector(query);
  return chunks
    .map((chunk, index) => ({
      ...chunk,
      score: cosineSimilarity(
        normalizeVector(chunk.embedding ?? embedTextToVector(chunk.text)),
        queryVector,
      ),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ index: _index, ...chunk }) => chunk);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let score = 0;
  for (let i = 0; i < length; i += 1) {
    score += a[i] * b[i];
  }
  return score;
}
