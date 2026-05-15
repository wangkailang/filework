/**
 * webFetchRendered — Layer 2'. Renders the URL in a hidden Electron
 * BrowserWindow so client-hydrated content lands in the HTML before
 * extraction. Returns the same shape as `webFetch` for symmetry.
 *
 * When to use: `webFetch` came back with empty / suspiciously thin
 * markdown for a page that's clearly an SPA (Next.js docs, x.com,
 * Notion pages, anything with significant client-side rendering).
 */
import { z } from "zod/v4";

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
    .max(1_000_000)
    .optional()
    .describe("Cap on `raw` body bytes, default 200_000."),
});

const DEFAULT_MAX_BYTES = 200_000;

export const buildWebFetchRenderedTool = (): ToolDefinition => ({
  name: "webFetchRendered",
  description:
    "Render a URL in a real Chromium window (Electron's own, not Playwright) and return clean reader-mode markdown + raw HTML. " +
    "Use ONLY after `webFetch` returned empty / very-thin markdown on a page that should have content (SPA, JS-rendered docs site, x.com/twitter, Notion). " +
    "Slower than `webFetch` (typically 2-4s) and capped at 2 parallel calls; don't use it as the default fetch. " +
    "If this also returns empty markdown, escalate to `webScrape` (Firecrawl).",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const {
      url,
      timeoutMs,
      settleMs,
      maxBytes = DEFAULT_MAX_BYTES,
    } = args as z.infer<typeof inputSchema>;
    const { html, finalUrl, status } = await fetchRenderedHtml(url, {
      timeoutMs,
      settleMs,
      signal: ctx.signal,
    });
    const readable = extractReadable(html, finalUrl);
    const truncated = html.length > maxBytes;
    return {
      status,
      statusText: status === null ? "load-failed" : "OK",
      url: finalUrl,
      contentType: "text/html",
      title: readable.title,
      excerpt: readable.excerpt,
      markdown: readable.markdown,
      raw: truncated ? html.slice(0, maxBytes) : html,
      truncated,
    };
  },
});
