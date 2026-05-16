/**
 * webFetch — Layer 1 extraction. Fetches a public URL via the injected
 * proxy-aware fetch, then runs the body through `extractReadable` so the
 * model gets clean markdown by default (cheap in tokens) plus the raw
 * HTML as a fallback. For JSON / plain-text responses, `markdown` is
 * empty and the model reads `raw` directly.
 *
 * Safety: `safe` — read-only, same tier as `readFile`. The injected
 * `fetchImpl` is the only network capability the tool exposes.
 */
import { z } from "zod/v4";

import type { ToolDefinition } from "../tool-registry";
import { extractReadable } from "./web-extract";

export interface WebFetchDeps {
  /** Main-process proxy-aware fetch. Production: `createProxyAwareFetch`. */
  fetchImpl: typeof fetch;
}

const inputSchema = z.object({
  url: z.string().url().describe("Absolute HTTP(S) URL to fetch."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .optional()
    .describe(
      "Cap on returned raw body bytes (default 200_000). Larger bodies are truncated and `truncated:true` is set. Does not affect the extracted `markdown` field.",
    ),
});

const DEFAULT_MAX_BYTES = 200_000;
// Hard ceiling — we refuse to read responses bigger than this even when
// the caller passes a larger `maxBytes`. Prevents an OOM from a server
// that streams 100MB of HTML before we'd otherwise get to truncate.
const ABSOLUTE_MAX_BYTES = 10_000_000;

// Looks like a real Chrome on Mac — improves yield on sites that lightly
// gate by UA. The "filework-agent" suffix is preserved so logs identify us.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 filework-agent";

const isHtml = (contentType: string): boolean =>
  contentType.toLowerCase().includes("html");

export const buildWebFetchTool = (deps: WebFetchDeps): ToolDefinition => ({
  name: "webFetch",
  description:
    "Fetch a public URL and return clean reader-mode markdown plus the raw body. Use this FIRST for any concrete URL — articles, blog posts, READMEs, docs, RSS, JSON APIs. " +
    "Read the `markdown` field for HTML pages (cheap on tokens); read `raw` for JSON/plain text or when `markdown` is empty. " +
    "If `markdown` is empty AND the page looked thin (JS-rendered SPA, x.com, etc.), retry with `webFetchRendered` for a real-browser load. " +
    "If that also fails (anti-bot, captcha), escalate to `webScrape`.",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const { url, maxBytes = DEFAULT_MAX_BYTES } = args as z.infer<
      typeof inputSchema
    >;
    const res = await deps.fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
      signal: ctx.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    // Refuse early when the server advertises a body that's too big to
    // hold in memory safely. res.text() below otherwise buffers the
    // entire body before maxBytes truncation can kick in.
    const advertised = Number(res.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > ABSOLUTE_MAX_BYTES) {
      return {
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        contentType,
        title: null,
        excerpt: null,
        markdown: "",
        raw: "",
        truncated: true,
        error: `Response too large (${advertised} bytes > ${ABSOLUTE_MAX_BYTES} byte cap). Use webFetchRendered or webScrape with format:'markdown' to get extraction without raw HTML.`,
      };
    }
    const raw = await res.text();
    const truncated = raw.length > maxBytes;
    const readable = isHtml(contentType)
      ? extractReadable(raw, res.url)
      : { title: null, excerpt: null, markdown: "", images: [] as string[] };
    return {
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      contentType,
      title: readable.title,
      excerpt: readable.excerpt,
      markdown: readable.markdown,
      images: readable.images,
      raw: truncated ? raw.slice(0, maxBytes) : raw,
      truncated,
    };
  },
});
