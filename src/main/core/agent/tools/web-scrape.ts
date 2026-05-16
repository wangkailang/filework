/**
 * webScrape — Layer 4 escape hatch. Hands the URL to Firecrawl which
 * does anti-bot bypass + JS rendering + clean extraction server-side.
 * Costs Firecrawl API quota (free tier: 500/month).
 *
 * The agent should try `webFetch` and `webFetchRendered` first; this
 * is reserved for sites those two can't crack (captchas, Cloudflare
 * Bot Management, X without auth, etc.).
 */
import { z } from "zod/v4";

import type { ToolDefinition } from "../tool-registry";
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
      // Firecrawl flattens OpenGraph + article meta into the top-level
      // `metadata` object. Field names vary by Firecrawl release; the
      // ones below are the stable / documented set we map into our
      // ArticleMeta shape.
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
      // Allow unknown extra fields without forcing `any`.
      [key: string]: unknown;
    };
  };
  error?: string;
}

/** Map Firecrawl's flat metadata object into our ArticleMeta shape. */
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
    "Scrape a URL via Firecrawl (handles anti-bot, JS rendering, captchas server-side). " +
    "Use ONLY when both `webFetch` and `webFetchRendered` failed (empty markdown, 403, captcha). " +
    "Costs Firecrawl API quota — Firecrawl free tier is 500 pages/month. " +
    "Returns clean markdown plus a `meta` object (byline/siteName/publishedTime/favicon/og) mapped from Firecrawl's metadata. " +
    "`images` / `videos` / `structuredData` are empty arrays here (Firecrawl doesn't itemize them; use webFetch when those matter).",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const { url, formats } = args as z.infer<typeof inputSchema>;
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
    return {
      status: res.status,
      url,
      title: metadata?.title ?? null,
      excerpt: metadata?.description ?? null,
      markdown: json.data?.markdown ?? "",
      html: json.data?.html ?? null,
      meta: metadata ? firecrawlMetaToArticleMeta(metadata) : {},
      // Firecrawl doesn't itemize images / videos / structured data the
      // way our HTML extractor does; emit empties for symmetry with
      // webFetch / webFetchRendered so renderer code can branch on a
      // single shape.
      images: [],
      videos: [],
      structuredData: [],
    };
  },
});
