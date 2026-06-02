/**
 * webFetch —— 第一层抽取。通过注入的代理感知 fetch 拉取公开 URL,再将正文交给
 * `extractReadable` 处理,使模型默认得到干净的 markdown(token 开销低),并保留
 * 原始 HTML 作为兜底。对于 JSON / 纯文本响应,`markdown` 为空,模型直接读取 `raw`。
 *
 * 安全级别:`safe` —— 只读,与 `readFile` 同档。注入的 `fetchImpl` 是本工具暴露的
 * 唯一网络能力。
 */
import { z } from "zod/v4";

import { type PdfSearchResult, searchPdfPages } from "../../../ai/pdf-search";
import {
  extractPdfTextFromBuffer,
  type PdfExtractResult,
} from "../../../ai/pdf-text";
import { searchText } from "../../../ai/text-search";
import type { ToolDefinition } from "../tool-registry";
import { extractReadable } from "./web-extract";

export interface WebFetchDeps {
  /** 主进程代理感知 fetch。生产环境:`createProxyAwareFetch`。 */
  fetchImpl: typeof fetch;
  /**
   * PDF → 文本抽取器。默认使用基于 pdf-parse 的共享抽取器。
   * 注入便于测试,使 PDF 分支无需真实 PDF 即可被覆盖。
   */
  extractPdf?: (data: Uint8Array) => Promise<PdfExtractResult>;
  /**
   * PDF 文档内搜索(带 `query` 时启用)。默认 = BM25 逐页搜索。注入便于测试。
   */
  searchPdf?: (data: Uint8Array, query: string) => Promise<PdfSearchResult>;
  /** PDF 下载字节上限,默认 50MB。注入便于测试流式硬停。 */
  pdfMaxBytes?: number;
}

const inputSchema = z.object({
  url: z.string().url().describe("Absolute HTTP(S) URL to fetch."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(256_000, {
      message:
        "maxBytes must be ≤ 256000 (256KB). webFetch reads the body INTO context — it is not a file downloader. To save a large file (multi-MB .txt/.csv/.zip) to disk, use runCommand with `curl -L -o <path> <url>` (or wget) AND set escalatePermissions:true — the sandbox blocks outbound network, so an un-escalated curl fails to connect (exit 7).",
    })
    .optional()
    .describe(
      "Cap on returned content bytes (default 200_000, hard max 256_000). Bounds whichever field carries the body into context — the extracted `markdown` for HTML, or `raw` otherwise. Larger bodies are truncated with `truncated:true`. This tool loads content into context — to DOWNLOAD a large file to disk, use runCommand `curl -L -o`/`wget` with escalatePermissions:true (network needs escalation), not webFetch.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "When set, return only the parts of the document most relevant to this query (BM25-ranked) instead of the whole body — for PDFs the matching pages (`matchedPages`), for HTML/text the matching chunks (`matchedChunks`). Use to pull a specific fact out of a long page/document without loading it all into context.",
    ),
});

const DEFAULT_MAX_BYTES = 200_000;
// 硬上限 —— 即使调用方传入更大的 `maxBytes`,也拒绝读取超过此值的响应。
// 防止服务器在我们来得及截断前先流式推送 100MB 的 HTML 而导致 OOM。
const ABSOLUTE_MAX_BYTES = 10_000_000;
// PDF 会被下载进临时 buffer、抽取文本后立即丢弃 —— 这些字节从不进入模型上下文,
// 因此可以容忍远大于 HTML 上限的体积。覆盖数 MB 的政府/档案类 PDF(例如 17MB 的
// Federal Register issue slice),这类文件原本会被 HTML 上限直接拒绝。
const PDF_DOWNLOAD_MAX_BYTES = 50_000_000;

// 伪装成 Mac 上的真实 Chrome —— 提升对那些轻度按 UA 拦截站点的成功率。
// 保留 "filework-agent" 后缀,使日志能识别出是我们。
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 filework-agent";

const isHtml = (contentType: string): boolean =>
  contentType.toLowerCase().includes("html");

// 路径以 `.pdf` 结尾,允许后接 query/fragment(如 `/report.pdf?v=2`)。
const looksLikePdfUrl = (url: string): boolean => /\.pdf(?:[?#]|$)/i.test(url);

// 判定 PDF:要么 content-type 声明,要么 URL 名为 `.pdf`(部分服务器对同样的
// 字节返回 `application/octet-stream`)。
const isPdf = (contentType: string, ...urls: string[]): boolean =>
  contentType.toLowerCase().includes("pdf") || urls.some(looksLikePdfUrl);

// 流式读取 response body 进内存,但累计字节一旦超过 limit 就取消读取并返回
// null。这样即使服务器用 chunked 传输、不发 content-length(`advertised` 卡口
// 失效),也不会被一个超大 body 撑爆内存。没有可读流时退回 arrayBuffer。
async function readBodyCapped(
  res: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > limit ? null : buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export const buildWebFetchTool = (deps: WebFetchDeps): ToolDefinition => {
  const extractPdf = deps.extractPdf ?? extractPdfTextFromBuffer;
  const searchPdf = deps.searchPdf ?? searchPdfPages;
  const pdfMaxBytes = deps.pdfMaxBytes ?? PDF_DOWNLOAD_MAX_BYTES;
  return {
    name: "webFetch",
    description:
      "Fetch a public URL and return clean reader-mode markdown plus the raw body, with side-channel fields: `meta` (byline/siteName/publishedTime/favicon/canonical/og), `images`, `videos`, `structuredData`. " +
      "PDFs are detected (by content-type or `.pdf` URL), downloaded, and text-extracted into `markdown` (page count in `pages`); `raw` stays empty for binary so the model reads `markdown`. " +
      "This is a plain HTTP fetch — it does NOT run JavaScript. If the page needs JS/session rendering (search-result pages, SPAs, dynamic `.aspx`/query pages) or the body comes back looking like a generic landing/home page instead of the resource you asked for, retry with `webFetchRendered`. Do not infer data from an empty or wrong page — switch tools or keep searching. If the URL 404s or the resource is gone, retry it through the Wayback Machine (`https://web.archive.org/web/2023/<url>`, or drop the year for the latest snapshot) before concluding it's unavailable — government, legal, and historical documents are very often preserved there.",
    safety: "safe",
    inputSchema,
    execute: async (args, ctx) => {
      const {
        url,
        maxBytes = DEFAULT_MAX_BYTES,
        query,
      } = args as z.infer<typeof inputSchema>;
      const res = await deps.fetchImpl(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html, application/json, text/plain, */*",
        },
        redirect: "follow",
        signal: ctx.signal,
      });
      const contentType = res.headers.get("content-type") ?? "";
      const pdf = isPdf(contentType, res.url, url);

      // 统一的返回骨架,保证每个出口都给出相同的字段集合;调用处只覆盖
      // 差异部分(markdown/raw/error/pages/truncated)。
      const base = (
        extra: Record<string, unknown>,
      ): Record<string, unknown> => ({
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        contentType,
        title: null,
        excerpt: null,
        markdown: "",
        images: [],
        videos: [],
        meta: {},
        structuredData: [],
        raw: "",
        truncated: false,
        ...extra,
      });

      // 快速通道:服务器若如实声明了过大的 content-length,一个字节都不下载就
      // 拒绝。PDF 因为字节是抽取后即丢弃(而非流入上下文),给更高的上限。
      const cap = pdf ? pdfMaxBytes : ABSOLUTE_MAX_BYTES;
      const advertised = Number(res.headers.get("content-length"));
      if (Number.isFinite(advertised) && advertised > cap) {
        return base({
          truncated: true,
          error: pdf
            ? `PDF too large (${advertised} bytes > ${cap} byte cap) to download and extract.`
            : `Response too large (${advertised} bytes > ${cap} byte cap). Use webFetchRendered or webScrape with format:'markdown' to get extraction without raw HTML.`,
        });
      }

      // PDF 分支 —— 流式读取并在 cap 处硬停(防 chunked 无 content-length 时
      // 无界缓冲),就地抽取文本作为 `markdown`;`raw` 保持为空,二进制永不到达模型。
      if (pdf) {
        const bytes = await readBodyCapped(res, cap);
        if (bytes === null) {
          return base({
            truncated: true,
            error: `PDF too large (exceeds ${cap} byte cap) to download and extract.`,
          });
        }
        // 带 query → BM25 文档内搜索,返回命中整页;否则抽全文(头部 80k 截断)。
        const q = query?.trim();
        if (q) {
          const searched = await searchPdf(bytes, q);
          if (!searched.ok) {
            return base({
              truncated: true,
              error: `PDF search failed: ${searched.error}`,
            });
          }
          return base({
            markdown: searched.markdown,
            truncated: searched.truncated,
            pages: searched.total,
            matchedPages: searched.matchedPages,
          });
        }
        const extracted = await extractPdf(bytes);
        if (!extracted.ok) {
          return base({
            truncated: true,
            error: `PDF text extraction failed: ${extracted.error}`,
          });
        }
        return base({
          markdown: extracted.text,
          truncated: extracted.truncated,
          pages: extracted.pages,
        });
      }

      const body = await res.text();
      const readable = isHtml(contentType)
        ? extractReadable(body, res.url)
        : {
            title: null,
            excerpt: null,
            markdown: "",
            images: [] as string[],
            videos: [],
            meta: {},
            structuredData: [],
          };
      // 只有一个字段把正文带入上下文:HTML 用蒸馏后的 `markdown`,否则用 `raw`。
      // 两者都返回(HTML 情况)会使 token 翻倍却无收益,因此一旦有了 markdown
      // 就丢弃冗余的 `raw`。
      const hasMarkdown = readable.markdown.length > 0;
      const content = hasMarkdown ? readable.markdown : body;
      const sideFields = {
        title: readable.title,
        excerpt: readable.excerpt,
        images: readable.images,
        videos: readable.videos,
        meta: readable.meta,
        structuredData: readable.structuredData,
      };

      // 带 query → BM25 文本检索,只回相关块(对应 PDF 的逐页检索),把长文
      // 从可能数 MB 压到几块。结果统一放 `markdown`(=与你 query 相关的内容)。
      const q = query?.trim();
      if (q) {
        const hit = searchText(content, q, { maxChars: maxBytes });
        return base({
          ...sideFields,
          markdown: hit.markdown,
          raw: "",
          truncated: hit.truncated,
          matchedChunks: hit.matchedChunks,
        });
      }

      // 无 query:返回承载字段并封顶到 maxBytes(markdown 此前未封顶,大文章
      // 同样会撑爆上下文)。
      let markdown = readable.markdown;
      let raw = hasMarkdown ? "" : body;
      const mdTruncated = markdown.length > maxBytes;
      const rawTruncated = raw.length > maxBytes;
      if (mdTruncated) markdown = markdown.slice(0, maxBytes);
      if (rawTruncated) raw = raw.slice(0, maxBytes);
      return base({
        ...sideFields,
        markdown,
        raw,
        truncated: mdTruncated || rawTruncated,
      });
    },
  };
};
