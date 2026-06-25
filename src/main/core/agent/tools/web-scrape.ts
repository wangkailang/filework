/**
 * webScrape — 第 4 层兜底方案。将 URL 交给 Firecrawl,由其在
 * 服务端完成反爬绕过 + JS 渲染 + 干净抽取。
 * 会消耗 Firecrawl API 配额(免费档:每月 500 次)。
 *
 * agent 应优先尝试 `webFetch` 和 `webFetchRendered`;本工具
 * 仅用于那两者攻不下的站点(验证码、Cloudflare
 * Bot Management、未登录的 X 等)。
 */
import { z } from "zod/v4";

import { searchText } from "../../../ai/text-search";
import type { ToolDefinition } from "../tool-registry";
import { projectWebFetchModelOutput } from "./model-output";
import type { ArticleMeta } from "./web-extract";

export interface WebScrapeDeps {
  fetchImpl: typeof fetch;
  resolveFirecrawlToken: () => Promise<string | null>;
}

const inputSchema = z.object({
  url: z.string().url().describe("Absolute HTTP(S) URL to scrape."),
  formats: z
    .array(z.enum(["markdown", "html"]))
    .optional()
    .describe("Default ['markdown']."),
  query: z
    .string()
    .optional()
    .describe(
      "When set, return only the chunks of `markdown` most relevant to this query (BM25-ranked) + `matchedChunks`, instead of the whole document.",
    ),
});

interface RawFirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
      // Firecrawl 把 OpenGraph + article meta 拍平到顶层的
      // `metadata` 对象里。字段名随 Firecrawl 版本而变;下面
      // 列出的是我们映射到 ArticleMeta 结构上的稳定 / 有文档
      // 记载的那一组。
      author?: string;
      publishedTime?: string;
      modifiedTime?: string;
      language?: string;
      ogTitle?: string;
      ogDescription?: string;
      ogType?: string;
      ogSiteName?: string;
      ogUrl?: string;
      ogImage?: string;
      ogVideo?: string;
      favicon?: string;
      // 允许出现未知的额外字段,且不必退化为 `any`。
      [key: string]: unknown;
    };
  };
  error?: string;
}

/** 把 Firecrawl 的扁平 metadata 对象映射成我们的 ArticleMeta 结构。 */
const firecrawlMetaToArticleMeta = (
  m: NonNullable<NonNullable<RawFirecrawlResponse["data"]>["metadata"]>,
): ArticleMeta => {
  const og: NonNullable<ArticleMeta["og"]> = {
    title: m.ogTitle || undefined,
    description: m.ogDescription || undefined,
    type: m.ogType || undefined,
    siteName: m.ogSiteName || undefined,
    url: m.ogUrl || undefined,
    image: m.ogImage || undefined,
    video: m.ogVideo || undefined,
  };
  const hasOg = Object.values(og).some((v) => typeof v === "string" && v);
  return {
    byline: m.author || undefined,
    siteName: m.ogSiteName || undefined,
    publishedTime: m.publishedTime || undefined,
    modifiedTime: m.modifiedTime || undefined,
    lang: m.language || undefined,
    canonical: m.sourceURL || undefined,
    favicon: m.favicon || undefined,
    og: hasOg ? og : undefined,
  };
};

export const buildWebScrapeTool = (deps: WebScrapeDeps): ToolDefinition => ({
  name: "webScrape",
  description:
    "Scrape a URL via Firecrawl (anti-bot + JS rendering + captcha bypass, server-side). Costs Firecrawl quota — use only when `webFetch` and `webFetchRendered` both failed. Returns markdown + `meta`; `images`/`videos`/`structuredData` come back empty.",
  safety: "safe",
  inputSchema,
  toModelOutput: ({ input, output }) =>
    projectWebFetchModelOutput({
      input: input as z.infer<typeof inputSchema>,
      output,
      toolName: "webScrape",
    }),
  execute: async (args, ctx) => {
    const { url, formats, query } = args as z.infer<typeof inputSchema>;
    const token = await deps.resolveFirecrawlToken();
    if (!token) {
      return {
        error:
          "No Firecrawl API key configured. Open Settings → Credentials → Add Credential → kind: Firecrawl.",
      };
    }
    const res = await deps.fetchImpl("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, formats: formats ?? ["markdown"] }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Firecrawl ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as RawFirecrawlResponse;
    if (json.error) {
      throw new Error(`Firecrawl returned error: ${json.error}`);
    }
    const metadata = json.data?.metadata;
    const fullMarkdown = json.data?.markdown ?? "";
    // 带 query 时,用 BM25 只检索相关片段,而非返回整篇文档
    // (通用上限负责约束体积;这一步保证内容相关性)。
    const q = query?.trim();
    const search = q ? searchText(fullMarkdown, q) : null;
    return {
      status: res.status,
      url,
      title: metadata?.title ?? null,
      excerpt: metadata?.description ?? null,
      markdown: search ? search.markdown : fullMarkdown,
      ...(search ? { matchedChunks: search.matchedChunks } : {}),
      html: json.data?.html ?? null,
      meta: metadata ? firecrawlMetaToArticleMeta(metadata) : {},
      // Firecrawl 不像我们的 HTML 抽取器那样逐项列出
      // images / videos / structured data;这里输出空值以与
      // webFetch / webFetchRendered 保持结构对称,使渲染端代码
      // 能基于单一结构做分支。
      images: [],
      videos: [],
      structuredData: [],
    };
  },
});
