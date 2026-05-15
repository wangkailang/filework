/**
 * Shared HTML → readable markdown helper. Used by `webFetch` (raw HTML
 * from undici) and `webFetchRendered` (rendered HTML from a hidden
 * Electron BrowserWindow) so both tools return the same shape.
 *
 * Stack: linkedom (DOM polyfill, lighter than jsdom) → readability
 * (Mozilla's reader-mode article extractor) → turndown (HTML → md).
 * Falls back to <title> + og:description / meta description when
 * readability can't isolate a main article.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  bulletListMarker: "-",
});

export interface ReadableOut {
  title: string | null;
  /** Short description — readability excerpt or og/meta fallback. */
  excerpt: string | null;
  /** Reader-mode markdown. Empty string when extraction yielded nothing. */
  markdown: string;
}

const attr = (
  doc: {
    querySelector(
      sel: string,
    ): { getAttribute(name: string): string | null } | null;
  },
  selector: string,
  name: string,
): string | null => doc.querySelector(selector)?.getAttribute(name) ?? null;

export const extractReadable = (html: string, url: string): ReadableOut => {
  const { document } = parseHTML(html);
  // linkedom doesn't populate document.baseURI from a string. Readability
  // uses baseURI to resolve relative links in the cleaned article body;
  // injecting a <base> tag makes the markdown output's links absolute.
  if (url && !document.querySelector("base")) {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.prepend(base);
  }

  const ogDescription =
    attr(document, 'meta[property="og:description"]', "content") ??
    attr(document, 'meta[name="description"]', "content");
  const titleFallback =
    document.querySelector("title")?.textContent?.trim() ??
    attr(document, 'meta[property="og:title"]', "content");

  let parsed: {
    title?: string | null;
    excerpt?: string | null;
    content?: string | null;
  } | null = null;
  try {
    // linkedom's Document is structurally compatible with Readability's
    // expected DOM Document, but their declared TS types differ — cast
    // through `unknown` to bypass the structural-type mismatch.
    parsed = new Readability(document as unknown as Document).parse();
  } catch {
    // Readability can throw on unusual DOMs; fall through to header-only output.
  }

  return {
    title: (parsed?.title ?? titleFallback ?? "").trim() || null,
    excerpt: (parsed?.excerpt ?? ogDescription ?? "").trim() || null,
    markdown: parsed?.content ? turndown.turndown(parsed.content) : "",
  };
};
