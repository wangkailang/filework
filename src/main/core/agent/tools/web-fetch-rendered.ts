/**
 * webFetchRendered — 第 2' 层。在隐藏的 Electron BrowserWindow 中渲染 URL,
 * 使客户端水合(hydrate)后的内容先落入 HTML, 再进行抽取。
 * 返回结构与 `webFetch` 保持一致以求对称。
 *
 * 使用时机: 当 `webFetch` 对一个明显是 SPA 的页面(Next.js 文档、x.com、
 * Notion 页面, 或任何有大量客户端渲染的页面)返回了空的 / 可疑地过于稀薄的
 * markdown 时。
 */
import { z } from "zod/v4";

import { searchText } from "../../../ai/text-search";
import { fetchRenderedHtml } from "../../../ipc/hidden-browser";
import type { ToolDefinition } from "../tool-registry";
import { extractReadable } from "./web-extract";

const inputSchema = z.object({
  url: z.string().url().describe("Absolute HTTP(S) URL to render."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .optional()
    .describe("Hard load timeout, default 15000."),
  settleMs: z
    .number()
    .int()
    .nonnegative()
    .max(10_000)
    .optional()
    .describe("Post-load hydration delay, default 1500."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(256_000)
    .optional()
    .describe(
      "Cap on returned content bytes (default 200_000, hard max 256_000).",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "When set, return only the chunks most relevant to this query (BM25-ranked) in `markdown` + `matchedChunks`, instead of the whole page.",
    ),
});

const DEFAULT_MAX_BYTES = 200_000;

export const buildWebFetchRenderedTool = (): ToolDefinition => ({
  name: "webFetchRendered",
  description:
    "Like `webFetch` but renders the URL in a real Chromium window first, so JS-hydrated content lands in the HTML. Slower (typically 2-4s) and capped at 2 parallel calls — use only when `webFetch` returned empty/thin markdown.",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const {
      url,
      timeoutMs,
      settleMs,
      maxBytes = DEFAULT_MAX_BYTES,
      query,
    } = args as z.infer<typeof inputSchema>;
    const { html, finalUrl, status } = await fetchRenderedHtml(url, {
      timeoutMs,
      settleMs,
      signal: ctx.signal,
    });
    const readable = extractReadable(html, finalUrl);
    const sideFields = {
      status,
      statusText: status === null ? "load-failed" : "OK",
      url: finalUrl,
      contentType: "text/html",
      title: readable.title,
      excerpt: readable.excerpt,
      images: readable.images,
      videos: readable.videos,
      meta: readable.meta,
      structuredData: readable.structuredData,
    };

    // 只有一个字段携带内容进入上下文: 页面优先用蒸馏后的 `markdown`, 否则用 `raw`。
    // 同时返回两者会使 token 翻倍, 因此一旦 markdown 存在就丢弃冗余的 raw。
    // 当带有 query 时, 仅用 BM25 检索相关的分片(chunk)。
    const hasMarkdown = readable.markdown.length > 0;
    const content = hasMarkdown ? readable.markdown : html;

    const q = query?.trim();
    if (q) {
      const hit = searchText(content, q, { maxChars: maxBytes });
      return {
        ...sideFields,
        markdown: hit.markdown,
        raw: "",
        truncated: hit.truncated,
        matchedChunks: hit.matchedChunks,
      };
    }

    let markdown = readable.markdown;
    let raw = hasMarkdown ? "" : html;
    const mdTruncated = markdown.length > maxBytes;
    const rawTruncated = raw.length > maxBytes;
    if (mdTruncated) markdown = markdown.slice(0, maxBytes);
    if (rawTruncated) raw = raw.slice(0, maxBytes);
    return {
      ...sideFields,
      markdown,
      raw,
      truncated: mdTruncated || rawTruncated,
    };
  },
});
