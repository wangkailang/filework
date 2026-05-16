/**
 * Shared HTML → readable markdown helper. Used by `webFetch` (raw HTML
 * from undici) and `webFetchRendered` (rendered HTML from a hidden
 * Electron BrowserWindow) so both tools return the same shape.
 *
 * Stack: linkedom (DOM polyfill, lighter than jsdom) → readability
 * (Mozilla's reader-mode article extractor) → turndown (HTML → md).
 * Falls back to <title> + og:description / meta description when
 * readability can't isolate a main article.
 *
 * Alongside the article body we surface higher-signal side outputs:
 *   - images:          inline img/srcset/og:image (gallery UI)
 *   - videos:          iframe embeds + <video> + og:video
 *   - meta:            byline/siteName/publishedTime/lang/favicon/canonical/og
 *   - structuredData:  JSON-LD subsets (Recipe / Product / NewsArticle / …)
 *
 * Everything is size-capped so we can't blow the LLM's context budget on
 * a rogue page that ships a 50KB schema.org blob.
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

// ─── Types ──────────────────────────────────────────────────────────

export interface ArticleMeta {
  byline?: string;
  siteName?: string;
  /** ISO-ish; Readability normalizes when it can, else page-provided. */
  publishedTime?: string;
  modifiedTime?: string;
  lang?: string;
  dir?: string;
  canonical?: string;
  favicon?: string;
  /** Full OG/Twitter card surface — link-preview cards will reuse this. */
  og?: {
    title?: string;
    description?: string;
    type?: string;
    siteName?: string;
    url?: string;
    image?: string;
    video?: string;
  };
}

export interface ExtractedVideo {
  url: string;
  kind: "iframe" | "video" | "og";
  provider?: "youtube" | "vimeo" | "bilibili" | "twitter" | "other";
  poster?: string;
  title?: string;
}

export interface StructuredDataItem {
  /** schema.org @type, e.g. "NewsArticle", "Recipe". */
  type: string;
  /** Whitelisted, size-trimmed subset of the original JSON-LD. */
  data: Record<string, unknown>;
}

export interface ReadableOut {
  title: string | null;
  excerpt: string | null;
  markdown: string;
  images: string[];
  videos: ExtractedVideo[];
  meta: ArticleMeta;
  structuredData: StructuredDataItem[];
}

// ─── Generic helpers ────────────────────────────────────────────────

const attr = (
  doc: {
    querySelector(
      sel: string,
    ): { getAttribute(name: string): string | null } | null;
  },
  selector: string,
  name: string,
): string | null => doc.querySelector(selector)?.getAttribute(name) ?? null;

const trimToUndef = (v: string | null | undefined): string | undefined => {
  if (!v) return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const resolveUrl = (raw: string, base: string): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(data:|blob:|javascript:)/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, base || "http://localhost/");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
};

// ─── Image collection (unchanged) ───────────────────────────────────

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
  const first = value.split(",")[0]?.trim() ?? "";
  return first.split(/\s+/)[0] ?? "";
};

const isLikelyTrackingPixel = (url: string): boolean => {
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
      break;
    }
  }
  return out;
};

// ─── Meta collection ────────────────────────────────────────────────

const FAVICON_RELS = [
  'link[rel="icon"]',
  'link[rel="shortcut icon"]',
  'link[rel="apple-touch-icon"]',
  'link[rel="apple-touch-icon-precomposed"]',
];

const collectFavicon = (
  document: ReturnType<typeof parseHTML>["document"],
  url: string,
): string | undefined => {
  for (const sel of FAVICON_RELS) {
    const href = attr(document, sel, "href");
    if (!href) continue;
    const resolved = resolveUrl(href, url);
    if (resolved) return resolved;
  }
  // Default well-known location — we don't fetch it, just suggest a URL.
  try {
    const origin = new URL(url || "http://localhost/").origin;
    return `${origin}/favicon.ico`;
  } catch {
    return undefined;
  }
};

const collectOg = (
  document: ReturnType<typeof parseHTML>["document"],
  url: string,
): ArticleMeta["og"] => {
  const get = (prop: string, alt?: string): string | undefined =>
    trimToUndef(
      attr(document, `meta[property="${prop}"]`, "content") ??
        (alt ? attr(document, `meta[name="${alt}"]`, "content") : null),
    );
  const og: ArticleMeta["og"] = {
    title: get("og:title", "twitter:title"),
    description: get("og:description", "twitter:description"),
    type: get("og:type"),
    siteName: get("og:site_name"),
    url: get("og:url"),
    image: get("og:image", "twitter:image"),
    video: get("og:video") ?? get("og:video:url") ?? get("og:video:secure_url"),
  };
  if (og.image) {
    const resolved = resolveUrl(og.image, url);
    if (resolved) og.image = resolved;
  }
  if (og.video) {
    const resolved = resolveUrl(og.video, url);
    if (resolved) og.video = resolved;
  }
  if (og.url) {
    const resolved = resolveUrl(og.url, url);
    if (resolved) og.url = resolved;
  }
  // Drop the object entirely if every field is empty — keeps output tidy.
  const hasAny = Object.values(og).some((v) => typeof v === "string" && v);
  return hasAny ? og : undefined;
};

interface ReadabilityParsed {
  title?: string | null;
  excerpt?: string | null;
  content?: string | null;
  byline?: string | null;
  siteName?: string | null;
  publishedTime?: string | null;
  lang?: string | null;
  dir?: string | null;
}

const collectMeta = (
  document: ReturnType<typeof parseHTML>["document"],
  url: string,
  parsed: ReadabilityParsed | null,
): ArticleMeta => {
  const lang =
    trimToUndef(parsed?.lang) ??
    trimToUndef(document.documentElement?.getAttribute("lang"));
  const dir =
    trimToUndef(parsed?.dir) ??
    trimToUndef(document.documentElement?.getAttribute("dir"));

  const canonicalRaw = attr(document, 'link[rel="canonical"]', "href");
  const canonical = canonicalRaw ? resolveUrl(canonicalRaw, url) : null;

  const modifiedTime =
    trimToUndef(
      attr(document, 'meta[property="article:modified_time"]', "content"),
    ) ??
    trimToUndef(attr(document, 'meta[property="og:updated_time"]', "content"));

  return {
    byline: trimToUndef(parsed?.byline),
    siteName:
      trimToUndef(parsed?.siteName) ??
      trimToUndef(attr(document, 'meta[property="og:site_name"]', "content")),
    publishedTime:
      trimToUndef(parsed?.publishedTime) ??
      trimToUndef(
        attr(document, 'meta[property="article:published_time"]', "content"),
      ),
    modifiedTime,
    lang,
    dir,
    canonical: canonical ?? undefined,
    favicon: collectFavicon(document, url),
    og: collectOg(document, url),
  };
};

// ─── Video collection ───────────────────────────────────────────────

const VIDEO_IFRAME_HOSTS: Array<{
  match: RegExp;
  provider: ExtractedVideo["provider"];
}> = [
  { match: /(?:^|\.)youtube\.com$/i, provider: "youtube" },
  { match: /^youtu\.be$/i, provider: "youtube" },
  { match: /(?:^|\.)youtube-nocookie\.com$/i, provider: "youtube" },
  { match: /^player\.vimeo\.com$/i, provider: "vimeo" },
  { match: /(?:^|\.)bilibili\.com$/i, provider: "bilibili" },
  { match: /^player\.bilibili\.com$/i, provider: "bilibili" },
  { match: /^platform\.twitter\.com$/i, provider: "twitter" },
];

const providerFromHost = (host: string): ExtractedVideo["provider"] => {
  for (const { match, provider } of VIDEO_IFRAME_HOSTS) {
    if (match.test(host)) return provider;
  }
  return undefined;
};

const normalizeYoutubeShortLink = (u: URL): URL => {
  // youtu.be/<id>  →  www.youtube.com/embed/<id>
  if (u.hostname === "youtu.be" && u.pathname.length > 1) {
    const id = u.pathname.slice(1).split("/")[0];
    if (id) {
      const out = new URL(`https://www.youtube.com/embed/${id}`);
      return out;
    }
  }
  return u;
};

const MAX_VIDEOS = 8;

const collectVideos = (
  document: ReturnType<typeof parseHTML>["document"],
  url: string,
): ExtractedVideo[] => {
  const out: ExtractedVideo[] = [];
  const seen = new Set<string>();

  const push = (v: ExtractedVideo): void => {
    if (out.length >= MAX_VIDEOS) return;
    if (seen.has(v.url)) return;
    seen.add(v.url);
    out.push(v);
  };

  // 1. iframes (most common case — YouTube/Vimeo embeds)
  for (const el of Array.from(document.querySelectorAll("iframe"))) {
    const src =
      el.getAttribute("src") ??
      el.getAttribute("data-src") ??
      el.getAttribute("data-lazy-src");
    if (!src) continue;
    const resolved = resolveUrl(src, url);
    if (!resolved) continue;
    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      continue;
    }
    const provider = providerFromHost(parsed.hostname);
    if (!provider) continue; // skip random iframes (ads, comments, etc.)
    const normalized = normalizeYoutubeShortLink(parsed).toString();
    push({
      url: normalized,
      kind: "iframe",
      provider,
      title: trimToUndef(el.getAttribute("title")),
    });
  }

  // 2. <video> elements (direct or with <source>)
  for (const el of Array.from(document.querySelectorAll("video"))) {
    const direct = el.getAttribute("src");
    const source =
      direct ?? el.querySelector("source")?.getAttribute("src") ?? null;
    if (!source) continue;
    const resolved = resolveUrl(source, url);
    if (!resolved) continue;
    const posterRaw = el.getAttribute("poster");
    const poster = posterRaw ? resolveUrl(posterRaw, url) : null;
    push({
      url: resolved,
      kind: "video",
      poster: poster ?? undefined,
      title: trimToUndef(el.getAttribute("title")),
    });
  }

  // 3. og:video / twitter:player as a last resort
  const ogVideo =
    attr(document, 'meta[property="og:video"]', "content") ??
    attr(document, 'meta[property="og:video:url"]', "content") ??
    attr(document, 'meta[property="og:video:secure_url"]', "content") ??
    attr(document, 'meta[name="twitter:player"]', "content");
  if (ogVideo) {
    const resolved = resolveUrl(ogVideo, url);
    if (resolved) {
      let provider: ExtractedVideo["provider"] = "other";
      try {
        provider = providerFromHost(new URL(resolved).hostname) ?? "other";
      } catch {
        // ignore
      }
      push({ url: resolved, kind: "og", provider });
    }
  }

  return out;
};

// ─── JSON-LD structured data ────────────────────────────────────────

// Per-type field whitelist. New types: add a row. Everything else gets
// dropped. The intent is to surface the *useful* core to the LLM, not
// every property a SEO tool dumped into the page.
const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  NewsArticle: [
    "headline",
    "author",
    "datePublished",
    "dateModified",
    "publisher",
    "description",
    "articleSection",
  ],
  Article: [
    "headline",
    "author",
    "datePublished",
    "dateModified",
    "publisher",
    "description",
  ],
  BlogPosting: [
    "headline",
    "author",
    "datePublished",
    "dateModified",
    "description",
  ],
  Recipe: [
    "name",
    "author",
    "description",
    "recipeYield",
    "totalTime",
    "cookTime",
    "prepTime",
    "recipeIngredient",
    "recipeInstructions",
    "aggregateRating",
  ],
  Product: [
    "name",
    "brand",
    "description",
    "offers",
    "aggregateRating",
    "sku",
    "gtin",
  ],
  Event: [
    "name",
    "startDate",
    "endDate",
    "location",
    "description",
    "organizer",
  ],
  Person: ["name", "jobTitle", "worksFor", "description", "url"],
  Organization: ["name", "url", "description", "sameAs"],
  JobPosting: [
    "title",
    "datePosted",
    "validThrough",
    "hiringOrganization",
    "jobLocation",
    "baseSalary",
    "employmentType",
    "description",
  ],
  VideoObject: [
    "name",
    "description",
    "thumbnailUrl",
    "uploadDate",
    "duration",
    "contentUrl",
    "embedUrl",
  ],
  Movie: ["name", "datePublished", "director", "actor", "genre", "description"],
  Book: ["name", "author", "isbn", "datePublished", "description"],
  SoftwareApplication: [
    "name",
    "applicationCategory",
    "operatingSystem",
    "offers",
    "aggregateRating",
    "description",
  ],
  Restaurant: ["name", "address", "telephone", "servesCuisine", "priceRange"],
  LocalBusiness: ["name", "address", "telephone", "url", "openingHours"],
  FAQPage: ["mainEntity"],
  HowTo: ["name", "totalTime", "supply", "tool", "step"],
};

const MAX_STRUCTURED_ITEMS = 3;
const MAX_STRUCTURED_SERIALIZED = 4096;

const flattenLdItems = (raw: unknown): unknown[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.flatMap(flattenLdItems);
  if (typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    return (obj["@graph"] as unknown[]).flatMap(flattenLdItems);
  }
  return [obj];
};

const typeOf = (item: unknown): string | null => {
  if (!item || typeof item !== "object") return null;
  const t = (item as Record<string, unknown>)["@type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    for (const cand of t) if (typeof cand === "string") return cand;
  }
  return null;
};

const pickFields = (
  item: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (item[f] !== undefined && item[f] !== null && item[f] !== "") {
      out[f] = item[f];
    }
  }
  return out;
};

const collectStructuredData = (
  document: ReturnType<typeof parseHTML>["document"],
): StructuredDataItem[] => {
  const out: StructuredDataItem[] = [];
  let serializedLen = 0;
  // We filter by `type` ourselves rather than using a CSS attribute
  // selector. linkedom's selector parser stumbles on the `/` and `+`
  // characters inside `"application/ld+json"`, returning zero matches.
  const scripts = Array.from(document.querySelectorAll("script")).filter(
    (el) =>
      (el.getAttribute("type") ?? "").toLowerCase() === "application/ld+json",
  );
  for (const el of scripts) {
    const txt = el.textContent ?? (el as { innerHTML?: string }).innerHTML;
    if (!txt) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(txt);
    } catch {
      continue; // malformed JSON-LD is sadly common — skip
    }
    for (const item of flattenLdItems(parsed)) {
      if (out.length >= MAX_STRUCTURED_ITEMS) break;
      const t = typeOf(item);
      if (!t) continue;
      const fields = SCHEMA_FIELDS[t];
      if (!fields) continue;
      const trimmed = pickFields(item as Record<string, unknown>, fields);
      if (Object.keys(trimmed).length === 0) continue;
      const candidate: StructuredDataItem = { type: t, data: trimmed };
      const next = serializedLen + JSON.stringify(candidate).length;
      if (next > MAX_STRUCTURED_SERIALIZED) {
        // Stop accepting more items once we'd blow the budget; partial
        // truncation of a single item would yield invalid schema slices.
        return out;
      }
      serializedLen = next;
      out.push(candidate);
    }
    if (out.length >= MAX_STRUCTURED_ITEMS) break;
  }
  return out;
};

// ─── Main entry ─────────────────────────────────────────────────────

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

  // Scan the original DOM for things Readability will strip before
  // we run it: <script> blocks (JSON-LD), <iframe> embeds (videos), and
  // the head <link>/<meta> nodes Readability sometimes prunes when it
  // rewrites the document.
  const videos = collectVideos(document, url);
  const structuredData = collectStructuredData(document);
  // Note: collectMeta also reads head, but Readability tends to leave
  // <link rel="canonical"> alone. Cheap to do up-front for safety.

  let parsed: ReadabilityParsed | null = null;
  try {
    // linkedom's Document is structurally compatible with Readability's
    // expected DOM Document, but their declared TS types differ — cast
    // through `unknown` to bypass the structural-type mismatch.
    parsed = new Readability(
      document as unknown as Document,
    ).parse() as ReadabilityParsed | null;
  } catch {
    // Readability can throw on unusual DOMs; fall through to header-only output.
  }

  const articleImages = parsed?.content
    ? collectImagesFromHtml(parsed.content, url)
    : [];
  const ogResolved = ogImage ? resolveUrl(ogImage, url) : null;
  const images =
    articleImages.length > 0 ? articleImages : ogResolved ? [ogResolved] : [];

  const meta = collectMeta(document, url, parsed);

  return {
    title: (parsed?.title ?? titleFallback ?? "").trim() || null,
    excerpt: (parsed?.excerpt ?? ogDescription ?? "").trim() || null,
    markdown: parsed?.content ? turndown.turndown(parsed.content) : "",
    images,
    videos,
    meta,
    structuredData,
  };
};
