/**
 * 共享的 HTML → 可读 markdown 辅助工具。被 `webFetch`（来自 undici 的
 * 原始 HTML）和 `webFetchRendered`（来自隐藏的 Electron BrowserWindow
 * 渲染后的 HTML）共用，使两个工具返回相同的结构。
 *
 * 技术栈：linkedom（DOM 垫片，比 jsdom 更轻量）→ readability
 *（Mozilla 的阅读模式正文提取器）→ turndown（HTML → md）。
 * 当 readability 无法分离出主正文时，回退到 <title> + og:description /
 * meta description。
 *
 * 在正文之外，我们还额外输出信噪比更高的旁路结果：
 *   - images:          内联 img/srcset/og:image（图库 UI）
 *   - videos:          iframe 嵌入 + <video> + og:video
 *   - meta:            byline/siteName/publishedTime/lang/favicon/canonical/og
 *   - structuredData:  JSON-LD 子集（Recipe / Product / NewsArticle / …）
 *
 * 所有内容都做了大小限制，以免某个塞了 50KB schema.org 数据块的
 * 异常页面撑爆 LLM 的上下文预算。
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

// ─── 类型定义 ──────────────────────────────────────────────────────────

export interface ArticleMeta {
  byline?: string;
  siteName?: string;
  /** 类 ISO 格式；Readability 能规范化时就规范化，否则用页面提供的原值。 */
  publishedTime?: string;
  modifiedTime?: string;
  lang?: string;
  dir?: string;
  canonical?: string;
  favicon?: string;
  /** 完整的 OG/Twitter 卡片信息 —— 链接预览卡片会复用它。 */
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
  /** schema.org 的 @type，例如 "NewsArticle"、"Recipe"。 */
  type: string;
  /** 经白名单筛选、按大小裁剪后的原始 JSON-LD 子集。 */
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

// ─── 通用辅助函数 ────────────────────────────────────────────────

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

// ─── 图片收集（未改动）───────────────────────────────────

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

// ─── 元信息收集 ────────────────────────────────────────────────

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
  // 默认的约定位置 —— 我们并不去抓取它，只是给出一个建议 URL。
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
  // 如果每个字段都为空，则整体丢弃该对象 —— 保持输出整洁。
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

// ─── 视频收集 ───────────────────────────────────────────────

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
// 对每种标签类型的 DOM 扫描长度做防御性上限。否则一个嵌入了数百条
// 推文 / 内联广告的论坛页面会付出完整的遍历开销，最终却因为提供商
// 白名单把所有内容都丢弃掉。
const MAX_SCAN_PER_TAG = 200;

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

  const iframes = Array.from(document.querySelectorAll("iframe")).slice(
    0,
    MAX_SCAN_PER_TAG,
  );
  for (const el of iframes) {
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
    if (!provider) continue; // 跳过无关的 iframe（广告、评论等）
    const normalized = normalizeYoutubeShortLink(parsed).toString();
    push({
      url: normalized,
      kind: "iframe",
      provider,
      title: trimToUndef(el.getAttribute("title")),
    });
  }

  const videos = Array.from(document.querySelectorAll("video")).slice(
    0,
    MAX_SCAN_PER_TAG,
  );
  for (const el of videos) {
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
        // 忽略
      }
      push({ url: resolved, kind: "og", provider });
    }
  }

  return out;
};

// ─── JSON-LD 结构化数据 ────────────────────────────────────────

// 按类型划分的字段白名单。新增类型：加一行即可。其余一律丢弃。
// 目的是把*有用的*核心信息呈现给 LLM，而不是 SEO 工具往页面里
// 塞的每一个属性。
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

// 跳过大于此值的 JSON-LD 脚本 —— 一个 200KB 的 schema 数据块在我们的
// 输出截断生效之前仍会被完整解析，而真正包含有用 Recipe/Product
// schema 的页面体积远低于此。那些塞入巨型 BreadcrumbList 图的 SEO
// 工具是典型的罪魁祸首。
const MAX_LD_SCRIPT_BYTES = 64 * 1024;

const collectStructuredData = (
  document: ReturnType<typeof parseHTML>["document"],
): StructuredDataItem[] => {
  const out: StructuredDataItem[] = [];
  let serializedLen = 0;
  // 我们自己按 `type` 过滤，而不使用 CSS 属性选择器。linkedom 的
  // 选择器解析器会被 `"application/ld+json"` 中的 `/` 和 `+` 字符卡住，
  // 导致返回零匹配。
  const scripts = Array.from(document.querySelectorAll("script"))
    .filter(
      (el) =>
        (el.getAttribute("type") ?? "").toLowerCase() === "application/ld+json",
    )
    .slice(0, MAX_SCAN_PER_TAG);
  for (const el of scripts) {
    const txt = el.textContent ?? (el as { innerHTML?: string }).innerHTML;
    if (!txt) continue;
    if (txt.length > MAX_LD_SCRIPT_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(txt);
    } catch {
      continue; // 格式错误的 JSON-LD 很常见 —— 跳过
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
        // 一旦会超出预算就停止接收更多条目；对单个条目做部分截断会
        // 产生无效的 schema 片段。
        return out;
      }
      serializedLen = next;
      out.push(candidate);
    }
    if (out.length >= MAX_STRUCTURED_ITEMS) break;
  }
  return out;
};

// ─── 主入口 ─────────────────────────────────────────────────────

export const extractReadable = (html: string, url: string): ReadableOut => {
  const { document } = parseHTML(html);
  // linkedom 不会从字符串填充 document.baseURI。Readability 用 baseURI
  // 来解析清洗后正文中的相对链接；注入一个 <base> 标签可让 markdown
  // 输出中的链接变成绝对地址。
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

  // 在运行 Readability 之前，先扫描原始 DOM 中那些会被它剥离的内容：
  // <script> 块（JSON-LD）、<iframe> 嵌入（视频），以及 Readability
  // 重写文档时有时会裁掉的 head 内 <link>/<meta> 节点。
  const videos = collectVideos(document, url);
  const structuredData = collectStructuredData(document);
  // 注意：collectMeta 也会读取 head，但 Readability 通常不会动
  // <link rel="canonical">。为保险起见提前处理，开销也很小。

  let parsed: ReadabilityParsed | null = null;
  try {
    // linkedom 的 Document 在结构上与 Readability 期望的 DOM Document
    // 兼容，但二者声明的 TS 类型不同 —— 通过 `unknown` 强转以绕过
    // 结构类型不匹配。
    parsed = new Readability(
      document as unknown as Document,
    ).parse() as ReadabilityParsed | null;
  } catch {
    // Readability 在异常 DOM 上可能抛错；此时回退到仅输出头部信息。
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
