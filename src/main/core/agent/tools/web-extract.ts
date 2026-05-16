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
  /**
   * Absolute image URLs collected from the reader-mode article body
   * (with og:image as a fallback). Deduped, http(s) only, tracking
   * pixels filtered out. Consumed by the renderer to show an image
   * gallery alongside the article text.
   */
  images: string[];
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

// Lazy-loaders we want to consult when `src` is empty / a 1px placeholder.
const LAZY_SRC_ATTRS = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-lazyload",
  "data-actualsrc",
  "data-srcset",
  "srcset",
];

const pickFirstFromSrcset = (value: string): string => {
  // srcset is "url 1x, url2 2x" — first comma-separated chunk's first token.
  const first = value.split(",")[0]?.trim() ?? "";
  return first.split(/\s+/)[0] ?? "";
};

const resolveUrl = (raw: string, base: string): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject inline data, blob, and javascript schemes outright.
  if (/^(data:|blob:|javascript:)/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, base || "http://localhost/");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
};

const isLikelyTrackingPixel = (url: string): boolean => {
  // Heuristic: 1px trackers usually carry `pixel`, `1x1`, or `spacer` in the path.
  const lower = url.toLowerCase();
  return (
    /(?:^|[/_-])pixel(?:[/_.-]|$)/.test(lower) ||
    /\b1x1\b/.test(lower) ||
    /\bspacer\b/.test(lower)
  );
};

const collectImagesFromHtml = (html: string, base: string): string[] => {
  if (!html) return [];
  const { document } = parseHTML(`<div>${html}</div>`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll("img"))) {
    const candidates: string[] = [];
    const src = el.getAttribute("src");
    if (src) candidates.push(src);
    for (const a of LAZY_SRC_ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      candidates.push(a.endsWith("srcset") ? pickFirstFromSrcset(v) : v);
    }
    for (const raw of candidates) {
      const resolved = resolveUrl(raw, base);
      if (!resolved) continue;
      if (isLikelyTrackingPixel(resolved)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
      break; // one URL per <img> element
    }
  }
  return out;
};

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
  const ogImage =
    attr(document, 'meta[property="og:image"]', "content") ??
    attr(document, 'meta[name="twitter:image"]', "content");

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

  // Prefer images that survived the reader-mode pass (article-body images,
  // not ads). Fall back to og:image so at least the share-card ships when
  // the article body had none.
  const articleImages = parsed?.content
    ? collectImagesFromHtml(parsed.content, url)
    : [];
  const ogResolved = ogImage ? resolveUrl(ogImage, url) : null;
  const images =
    articleImages.length > 0 ? articleImages : ogResolved ? [ogResolved] : [];

  return {
    title: (parsed?.title ?? titleFallback ?? "").trim() || null,
    excerpt: (parsed?.excerpt ?? ogDescription ?? "").trim() || null,
    markdown: parsed?.content ? turndown.turndown(parsed.content) : "",
    images,
  };
};
