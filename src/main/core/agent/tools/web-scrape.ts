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
    };
  };
  error?: string;
}

export const buildWebScrapeTool = (deps: WebScrapeDeps): ToolDefinition => ({
  name: "webScrape",
  description:
    "Scrape a URL via Firecrawl (handles anti-bot, JS rendering, captchas server-side). " +
    "Use ONLY when both `webFetch` and `webFetchRendered` failed (empty markdown, 403, captcha). " +
    "Costs Firecrawl API quota — Firecrawl free tier is 500 pages/month. " +
    "Returns clean markdown.",
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
    return {
      status: res.status,
      url,
      title: json.data?.metadata?.title ?? null,
      excerpt: json.data?.metadata?.description ?? null,
      markdown: json.data?.markdown ?? "",
      html: json.data?.html ?? null,
    };
  },
});
