/**
 * youtubeTranscript — fetch the captions of a YouTube video as
 * time-stamped segments + concatenated full text. Closes the GAIA
 * "what does the speaker say in the video at URL X" gap that
 * `webFetch` / `webFetchRendered` can't handle (those return only the
 * watch-page metadata, not the transcript).
 *
 * Mechanism:
 *   1. Resolve the input (watch URL / share URL / embed URL / bare
 *      11-char video ID) to a video ID.
 *   2. Fetch `https://www.youtube.com/watch?v=<id>` via the injected
 *      proxy-aware fetch.
 *   3. Pull `ytInitialPlayerResponse = { ... };` out of the page
 *      (brace-counting parser so we don't choke on nested JSON), parse
 *      it, and walk to `captions.playerCaptionsTracklistRenderer.
 *      captionTracks`.
 *   4. Pick the requested language (or English / first available) and
 *      fetch its `baseUrl` with `&fmt=json3` for clean JSON.
 *   5. Flatten the json3 `events` into `{ start, duration, text }`
 *      segments and a concatenated `fullText`.
 *
 * No new dependency — same `fetchImpl` plumbing as `webFetch`, so the
 * tool respects whatever proxy / UA configuration the rest of the web
 * stack uses. Brittle to YouTube's HTML changes; if `ytInitialPlayerResponse`
 * disappears we'll surface a clear error rather than a half-parsed
 * result.
 *
 * Safety: `safe` — read-only, no different from `webFetch`.
 */
import { z } from "zod/v4";

import type { ToolDefinition } from "../tool-registry";

export interface YoutubeTranscriptDeps {
  /** Main-process proxy-aware fetch. Production: `createProxyAwareFetch`. */
  fetchImpl: typeof fetch;
}

// ─── Pure helpers (exported for unit tests) ──────────────────────────

/**
 * Extract an 11-char YouTube video id from a URL or accept a bare id.
 * Returns `null` for inputs we don't recognise.
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
 * Find the `ytInitialPlayerResponse = { ... };` assignment in the
 * watch-page HTML and return the JSON string slice (no outer
 * semicolon). Returns `null` when the marker is absent.
 *
 * Uses a brace-counting walk (string- and escape-aware) instead of a
 * non-greedy regex because the JSON contains nested braces and quoted
 * strings with escaped characters.
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
  /** YouTube's display name, e.g. "English (auto-generated)". */
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
 * Normalise the captions block of a parsed player response into a
 * plain `CaptionTrack[]`. Drops tracks without a `baseUrl` or
 * `languageCode`.
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
 * Pick the most appropriate caption track for the requested language:
 *   1. exact `languageCode` match,
 *   2. prefix match (e.g. "en" matches "en-US"),
 *   3. English fallback ("en" / "en-*"),
 *   4. first track.
 *
 * Returns `null` only when the input list is empty.
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
  /** Start time in seconds. */
  start: number;
  /** Duration in seconds. */
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
 * Convert a `&fmt=json3` caption document into clean segments + a
 * single concatenated string. Drops zero-text events (json3 uses some
 * events purely for window/style timing).
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

// ─── Tool definition ─────────────────────────────────────────────────

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
    const { url, lang } = args as z.infer<typeof inputSchema>;
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
      throw new Error(
        `Video ${videoId} has no caption tracks available (no auto-captions, no manual subtitles).`,
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

    return {
      videoId,
      title: player.videoDetails?.title ?? null,
      language: track.languageCode,
      trackName: track.name ?? null,
      kind: track.kind ?? null,
      segments,
      fullText,
      availableLanguages: tracks.map((t) => t.languageCode),
    };
  },
});
