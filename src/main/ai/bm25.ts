/**
 * 轻量 BM25 文档内排序。把每个文档(这里是 PDF 的每一页)当作一篇 doc,按与
 * query 的 BM25 相关度打分排序 —— 用于在长文档里定位"答案所在页",取代位置式
 * 头部截断。纯函数、零依赖,可独立测试。
 */

export interface Bm25Hit {
  /** 对应输入 `docs` 数组的下标。 */
  index: number;
  score: number;
}

export interface Bm25Options {
  /** 词频饱和参数,默认 1.5。 */
  k1?: number;
  /** 文档长度归一化强度,默认 0.75。 */
  b?: number;
}

// Unicode 友好分词:小写化后按"非字母数字"切分,保留数字(GAIA 答案常是数字)。
const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * 对 `docs` 按与 `query` 的 BM25 相关度降序排序。返回**每个**文档(包含 0 分的),
 * 便于调用方决定"取命中页"还是"无命中时回退"。同分时保持输入顺序(稳定排序)。
 */
export function rankBm25(
  docs: string[],
  query: string,
  opts: Bm25Options = {},
): Bm25Hit[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  if (docs.length === 0) return [];

  const docTokens = docs.map(tokenize);
  const docLengths = docTokens.map((t) => t.length);
  const avgdl = docLengths.reduce((sum, n) => sum + n, 0) / docs.length || 0;

  // 每篇文档的词频表。
  const termFreqs = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    return tf;
  });

  const queryTerms = [...new Set(tokenize(query))];

  // 每个查询词的文档频率(含该词的文档数)。
  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const tf of termFreqs) if (tf.has(term)) df++;
    docFreq.set(term, df);
  }

  const N = docs.length;
  const scores = termFreqs.map((tf, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const df = docFreq.get(term) ?? 0;
      // BM25+ 形式的 IDF:始终非负,避免高频词产生负分。
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = f + k1 * (1 - b + (b * docLengths[i]) / (avgdl || 1));
      score += idf * ((f * (k1 + 1)) / denom);
    }
    return { index: i, score };
  });

  // 稳定降序:同分保持原下标顺序(Array.prototype.sort 在现代引擎稳定)。
  return scores.sort((a, b2) => b2.score - a.score);
}
