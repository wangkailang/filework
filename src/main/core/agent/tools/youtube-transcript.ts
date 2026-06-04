/**
 * youtubeTranscript — 获取 YouTube 视频的字幕,返回带时间戳的
 * 分段 + 拼接后的完整文本。弥补了 GAIA 中
 * “URL X 的视频里讲话者说了什么” 这一类
 * `webFetch` / `webFetchRendered` 无法处理的场景(那两个只返回
 * 观看页的元数据,而非字幕文稿)。
 *
 * 机制:
 *   1. 把输入(观看 URL / 分享 URL / 嵌入 URL / 纯
 *      11 字符视频 ID)解析为视频 ID。
 *   2. 通过注入的代理感知 fetch 获取
 *      `https://www.youtube.com/watch?v=<id>`。
 *   3. 从页面中抽取 `ytInitialPlayerResponse = { ... };`
 *      (用括号计数解析器,以免被嵌套 JSON 卡住),解析
 *      它,并沿路径走到 `captions.playerCaptionsTracklistRenderer.
 *      captionTracks`。
 *   4. 选取请求的语言(或英文 / 第一个可用项),并
 *      用 `&fmt=json3` 获取其 `baseUrl` 以得到干净的 JSON。
 *   5. 把 json3 的 `events` 展平为 `{ start, duration, text }`
 *      分段以及拼接后的 `fullText`。
 *
 * 没有新依赖 —— 与 `webFetch` 使用相同的 `fetchImpl` 管线,因此该
 * 工具遵循 web 栈其余部分所用的代理 / UA 配置。对 YouTube 的 HTML
 * 变更比较脆弱;若 `ytInitialPlayerResponse`
 * 消失,我们会抛出明确的错误,而不是返回半解析的
 * 结果。
 *
 * 安全性: `safe` —— 只读,与 `webFetch` 无异。
 */
import { z } from "zod/v4";

import { searchText } from "../../../ai/text-search";
import type { ToolDefinition } from "../tool-registry";

export interface YoutubeTranscriptDeps {
  /** 主进程的代理感知 fetch。生产环境: `createProxyAwareFetch`。 */
  fetchImpl: typeof fetch;
}

// ─── 纯函数辅助方法(导出供单元测试使用) ──────────────────────────

/**
 * 从 URL 中抽取 11 字符的 YouTube 视频 id,或直接接受一个纯 id。
 * 对无法识别的输入返回 `null`。
 */
export const extractVideoId = (input: string): string | null => {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = parsed.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = parsed.pathname.match(
      /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/,
    );
    if (m) return m[1];
  }
  return null;
};

/**
 * 在观看页的 HTML 中查找 `ytInitialPlayerResponse = { ... };`
 * 赋值语句,并返回其 JSON 字符串切片(不含外层
 * 分号)。标记不存在时返回 `null`。
 *
 * 使用括号计数遍历(可感知字符串与转义),而非
 * 非贪婪正则,因为该 JSON 含有嵌套括号以及带转义
 * 字符的引号字符串。
 */
export const extractPlayerResponseJson = (html: string): string | null => {
  const markers = [
    "var ytInitialPlayerResponse = ",
    "ytInitialPlayerResponse = ",
    'window["ytInitialPlayerResponse"] = ',
  ];
  let start = -1;
  for (const m of markers) {
    const i = html.indexOf(m);
    if (i !== -1) {
      start = i + m.length;
      break;
    }
  }
  if (start === -1) return null;
  if (html[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  return null;
};

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** YouTube 的显示名称,例如 "English (auto-generated)"。 */
  name?: string;
  kind?: string;
  isTranslatable?: boolean;
}

interface CaptionTrackName {
  simpleText?: string;
  runs?: Array<{ text?: string }>;
}

interface PlayerResponseShape {
  videoDetails?: { title?: string; videoId?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
        isTranslatable?: boolean;
        name?: CaptionTrackName;
      }>;
    };
  };
  playabilityStatus?: { status?: string; reason?: string };
}

const flattenName = (
  name: CaptionTrackName | undefined,
): string | undefined => {
  if (!name) return undefined;
  if (typeof name.simpleText === "string") return name.simpleText;
  if (Array.isArray(name.runs)) {
    return name.runs.map((r) => r.text ?? "").join("");
  }
  return undefined;
};

/**
 * 把已解析的 player response 中的字幕块归一化为
 * 普通的 `CaptionTrack[]`。丢弃没有 `baseUrl` 或
 * `languageCode` 的轨道。
 */
export const extractCaptionTracks = (
  playerResponse: PlayerResponseShape,
): CaptionTrack[] => {
  const raw =
    playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
    [];
  const out: CaptionTrack[] = [];
  for (const t of raw) {
    if (!t.baseUrl || !t.languageCode) continue;
    out.push({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind,
      isTranslatable: t.isTranslatable,
      name: flattenName(t.name),
    });
  }
  return out;
};

/**
 * 为请求的语言挑选最合适的字幕轨道:
 *   1. `languageCode` 精确匹配,
 *   2. 前缀匹配(例如 "en" 匹配 "en-US"),
 *   3. 回退到英文("en" / "en-*"),
 *   4. 第一个轨道。
 *
 * 仅当输入列表为空时返回 `null`。
 */
export const pickCaptionTrack = (
  tracks: CaptionTrack[],
  preferredLang?: string,
): CaptionTrack | null => {
  if (tracks.length === 0) return null;
  if (preferredLang) {
    const exact = tracks.find((t) => t.languageCode === preferredLang);
    if (exact) return exact;
    const prefix = tracks.find((t) =>
      t.languageCode.toLowerCase().startsWith(preferredLang.toLowerCase()),
    );
    if (prefix) return prefix;
  }
  const en = tracks.find(
    (t) =>
      t.languageCode === "en" || t.languageCode.toLowerCase().startsWith("en-"),
  );
  if (en) return en;
  return tracks[0];
};

export interface TranscriptSegment {
  /** 起始时间(秒)。 */
  start: number;
  /** 时长(秒)。 */
  duration: number;
  text: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

interface Json3Doc {
  events?: Json3Event[];
}

/**
 * 把 `&fmt=json3` 的字幕文档转换为干净的分段 + 一个
 * 拼接后的字符串。丢弃无文本的 event(json3 中有些
 * event 纯粹用于窗口/样式计时)。
 */
export const parseJson3 = (
  doc: Json3Doc,
): { segments: TranscriptSegment[]; fullText: string } => {
  const segments: TranscriptSegment[] = [];
  for (const e of doc.events ?? []) {
    if (e.tStartMs === undefined) continue;
    const text = (e.segs ?? [])
      .map((s) => s.utf8 ?? "")
      .join("")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    segments.push({
      start: e.tStartMs / 1000,
      duration: (e.dDurationMs ?? 0) / 1000,
      text,
    });
  }
  const fullText = segments.map((s) => s.text).join(" ");
  return { segments, fullText };
};

// ─── 工具定义 ─────────────────────────────────────────────────

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      "YouTube watch URL, share URL (youtu.be/...), embed URL, or bare 11-char video id.",
    ),
  lang: z
    .string()
    .min(2)
    .max(10)
    .optional()
    .describe(
      "BCP-47 language code preference, e.g. 'en', 'zh', 'es'. Falls back to English then first available.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "When set, return only the parts of the transcript most relevant to this query (BM25-ranked) in `fullText` + `matchedChunks`, instead of the whole transcript — for long videos.",
    ),
});

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 filework-agent";

export const buildYoutubeTranscriptTool = (
  deps: YoutubeTranscriptDeps,
): ToolDefinition => ({
  name: "youtubeTranscript",
  description:
    "Fetch the captions of a YouTube video as time-stamped segments and a concatenated full text. " +
    "Pass a watch URL, share URL (youtu.be/...), embed URL, or a bare 11-char video id. " +
    "Use this for any question about what is SAID in a YouTube video — keyword counts, quotes, summaries, timestamps. " +
    "`webFetch` on a YouTube URL returns only the watch-page metadata, not the transcript; use this tool instead. " +
    "Returns videoId, title, language (the track actually selected), segments[{start,duration,text}], fullText. " +
    "Errors when the video has no captions, is private/age-restricted, or has been removed.",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const { url, lang, query } = args as z.infer<typeof inputSchema>;
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error(
        `Could not extract a YouTube video id from input: ${url}`,
      );
    }

    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageRes = await deps.fetchImpl(watchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ctx.signal,
    });
    if (!pageRes.ok) {
      throw new Error(
        `YouTube watch page returned ${pageRes.status} ${pageRes.statusText} for ${videoId}`,
      );
    }
    const html = await pageRes.text();

    const jsonStr = extractPlayerResponseJson(html);
    if (!jsonStr) {
      throw new Error(
        `Could not locate ytInitialPlayerResponse in watch page for ${videoId} (YouTube page format may have changed, or the video is unavailable).`,
      );
    }
    let player: PlayerResponseShape;
    try {
      player = JSON.parse(jsonStr) as PlayerResponseShape;
    } catch (err) {
      throw new Error(
        `Failed to parse ytInitialPlayerResponse JSON for ${videoId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (player.playabilityStatus?.status === "ERROR") {
      throw new Error(
        `Video ${videoId} is unplayable: ${
          player.playabilityStatus.reason ?? "unknown reason"
        }`,
      );
    }

    const tracks = extractCaptionTracks(player);
    if (tracks.length === 0) {
      // 视频本身没有任何字幕(作者未上传、YouTube 也未自动生成)。
      // 这是视频的固有属性,而非抓取失败 — 明确告知模型据此向用户解释。
      throw new Error(
        `This video has no subtitles available — the uploader did not add captions ` +
          `and YouTube did not auto-generate any (common for music or non-speech videos). ` +
          `This is a property of the video, not a fetch failure. ` +
          `Tell the user the video simply has no transcript; do not retry. (videoId=${videoId})`,
      );
    }
    const track = pickCaptionTrack(tracks, lang);
    if (!track) {
      throw new Error(
        `No caption track matched lang=${lang} for ${videoId}. Available: ${tracks
          .map((t) => t.languageCode)
          .join(", ")}`,
      );
    }

    const trackUrl = `${track.baseUrl}${
      track.baseUrl.includes("?") ? "&" : "?"
    }fmt=json3`;
    const trackRes = await deps.fetchImpl(trackUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: ctx.signal,
    });
    if (!trackRes.ok) {
      throw new Error(
        `Caption track fetch failed (${trackRes.status} ${trackRes.statusText}) for ${videoId} lang=${track.languageCode}`,
      );
    }
    const trackText = await trackRes.text();
    // YouTube 反爬:字幕轨道在播放页里存在,但 timedtext 接口对缺少有效
    // PO token(proof-of-origin)的请求会返回 200 + 空 body,而非真正的字幕。
    // 这是平台访问限制,不是抓取 bug — 明确告知模型,避免它把空响应当成
    // JSON 解析故障并反复重试。
    if (trackText.trim().length === 0) {
      throw new Error(
        `YouTube returned an empty caption track for this video — the subtitle ` +
          `endpoint refused the request (it requires a proof-of-origin token that ` +
          `this tool cannot generate). The video DOES have subtitles, but YouTube ` +
          `is blocking programmatic access. This is a platform restriction, not a ` +
          `fetch failure; do not retry. Tell the user the transcript could not be ` +
          `retrieved due to YouTube access restrictions. (videoId=${videoId})`,
      );
    }
    let json3: Json3Doc;
    try {
      json3 = JSON.parse(trackText) as Json3Doc;
    } catch (err) {
      throw new Error(
        `Failed to parse caption JSON for ${videoId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const { segments, fullText } = parseJson3(json3);

    // 有 query 时,用 BM25 仅检索相关的字幕片段(长视频
    // 的文稿可能达到数百 KB);否则返回完整文稿。
    const q = query?.trim();
    const search = q ? searchText(fullText, q) : null;

    return {
      videoId,
      title: player.videoDetails?.title ?? null,
      language: track.languageCode,
      trackName: track.name ?? null,
      kind: track.kind ?? null,
      segments,
      fullText: search ? search.markdown : fullText,
      ...(search ? { matchedChunks: search.matchedChunks } : {}),
      availableLanguages: tracks.map((t) => t.languageCode),
    };
  },
});
