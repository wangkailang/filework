import { describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../tool-registry";
import {
  buildYoutubeTranscriptTool,
  extractCaptionTracks,
  extractPlayerResponseJson,
  extractVideoId,
  parseJson3,
  pickCaptionTrack,
} from "../tools/youtube-transcript";

// ─── extractVideoId ──────────────────────────────────────────────────

describe("extractVideoId", () => {
  it("accepts a bare 11-char video id", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rejects ids that are not exactly 11 chars", () => {
    expect(extractVideoId("dQw4w9WgXc")).toBeNull();
    expect(extractVideoId("dQw4w9WgXcQQ")).toBeNull();
  });

  it("parses a standard watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses watch URL with extra query params", () => {
    expect(
      extractVideoId(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLfoo",
      ),
    ).toBe("dQw4w9WgXcQ");
  });

  it("parses the youtu.be short URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses embed / shorts / live URLs", () => {
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("handles youtube-nocookie.com (embed-only domain)", () => {
    expect(
      extractVideoId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-YouTube URLs", () => {
    expect(extractVideoId("https://vimeo.com/123456789")).toBeNull();
    expect(extractVideoId("https://www.google.com/search?v=foo")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId("")).toBeNull();
  });
});

// ─── extractPlayerResponseJson ───────────────────────────────────────

describe("extractPlayerResponseJson", () => {
  it("extracts a nested-brace JSON payload via the brace counter", () => {
    const inner = `{"a": {"b": {"c": "}{nested}{"}}}`;
    const html = `<html><script>var ytInitialPlayerResponse = ${inner};var x=1;</script></html>`;
    expect(extractPlayerResponseJson(html)).toBe(inner);
  });

  it("respects string boundaries (a } inside a string is not the end)", () => {
    const inner = `{"label": "value with } and \\" escape"}`;
    const html = `<script>var ytInitialPlayerResponse = ${inner};</script>`;
    expect(extractPlayerResponseJson(html)).toBe(inner);
  });

  it('handles the alternative window["..."] assignment form', () => {
    const inner = `{"k":"v"}`;
    const html = `<script>window["ytInitialPlayerResponse"] = ${inner};</script>`;
    expect(extractPlayerResponseJson(html)).toBe(inner);
  });

  it("returns null when the marker is absent", () => {
    expect(extractPlayerResponseJson("<html>no marker</html>")).toBeNull();
  });

  it("returns null when the marker is present but not followed by an object", () => {
    expect(
      extractPlayerResponseJson("var ytInitialPlayerResponse = null;"),
    ).toBeNull();
  });
});

// ─── extractCaptionTracks ────────────────────────────────────────────

describe("extractCaptionTracks", () => {
  it("returns an empty list when captions are absent", () => {
    expect(extractCaptionTracks({})).toEqual([]);
    expect(extractCaptionTracks({ captions: {} })).toEqual([]);
  });

  it("flattens captionTracks and drops entries missing required fields", () => {
    const tracks = extractCaptionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://example.com/en",
              languageCode: "en",
              kind: "asr",
              name: { simpleText: "English (auto-generated)" },
            },
            {
              baseUrl: "https://example.com/zh",
              languageCode: "zh-Hans",
              name: { runs: [{ text: "中文" }, { text: " (简体)" }] },
            },
            // Dropped — no baseUrl.
            { languageCode: "fr" },
            // Dropped — no languageCode.
            { baseUrl: "https://example.com/x" },
          ],
        },
      },
    });
    expect(tracks).toEqual([
      {
        baseUrl: "https://example.com/en",
        languageCode: "en",
        kind: "asr",
        isTranslatable: undefined,
        name: "English (auto-generated)",
      },
      {
        baseUrl: "https://example.com/zh",
        languageCode: "zh-Hans",
        kind: undefined,
        isTranslatable: undefined,
        name: "中文 (简体)",
      },
    ]);
  });
});

// ─── pickCaptionTrack ────────────────────────────────────────────────

const TRACKS = [
  { baseUrl: "u-zh", languageCode: "zh-Hans" },
  { baseUrl: "u-en-us", languageCode: "en-US" },
  { baseUrl: "u-en", languageCode: "en" },
  { baseUrl: "u-es", languageCode: "es" },
];

describe("pickCaptionTrack", () => {
  it("returns null for an empty list", () => {
    expect(pickCaptionTrack([])).toBeNull();
  });

  it("prefers exact languageCode match", () => {
    expect(pickCaptionTrack(TRACKS, "en-US")?.baseUrl).toBe("u-en-us");
    expect(pickCaptionTrack(TRACKS, "zh-Hans")?.baseUrl).toBe("u-zh");
  });

  it("falls back to prefix match", () => {
    expect(pickCaptionTrack(TRACKS, "zh")?.baseUrl).toBe("u-zh");
  });

  it("falls back to English when preferred lang is absent", () => {
    expect(pickCaptionTrack(TRACKS, "fr")?.baseUrl).toBe("u-en-us");
  });

  it("falls back to the first track when no English and no preference", () => {
    const noEnglish = [
      { baseUrl: "u-fr", languageCode: "fr" },
      { baseUrl: "u-de", languageCode: "de" },
    ];
    expect(pickCaptionTrack(noEnglish)?.baseUrl).toBe("u-fr");
  });

  it("with no preferred lang, English is preferred over the first slot", () => {
    expect(pickCaptionTrack(TRACKS)?.baseUrl).toBe("u-en-us");
  });
});

// ─── parseJson3 ──────────────────────────────────────────────────────

describe("parseJson3", () => {
  it("flattens segs, drops timing-only events, and concatenates fullText", () => {
    const doc = {
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1500,
          segs: [{ utf8: "Hello" }, { utf8: " world" }],
        },
        { tStartMs: 1500, dDurationMs: 100 },
        { tStartMs: 2000, dDurationMs: 200, segs: [{ utf8: "" }] },
        {
          tStartMs: 3000,
          dDurationMs: 1200,
          segs: [{ utf8: "second\nline" }, { utf8: "   here" }],
        },
        { dDurationMs: 100, segs: [{ utf8: "no start" }] },
      ],
    };
    const { segments, fullText } = parseJson3(doc);
    expect(segments).toEqual([
      { start: 0, duration: 1.5, text: "Hello world" },
      { start: 3, duration: 1.2, text: "second line here" },
    ]);
    expect(fullText).toBe("Hello world second line here");
  });

  it("returns empty for an empty doc", () => {
    expect(parseJson3({})).toEqual({ segments: [], fullText: "" });
    expect(parseJson3({ events: [] })).toEqual({ segments: [], fullText: "" });
  });
});

// ─── End-to-end (tool execute, mock fetch) ───────────────────────────

const buildCtx = (): ToolContext => ({
  workspace: undefined as never,
  signal: new AbortController().signal,
  toolCallId: "test-call",
});

const buildWatchHtml = (playerObj: unknown): string =>
  `<!doctype html><html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(
    playerObj,
  )};</script></body></html>`;

const buildJson3 = (events: unknown[]): string => JSON.stringify({ events });

describe("buildYoutubeTranscriptTool.execute", () => {
  it("happy path: fetches watch page + caption track and returns segments", async () => {
    const watchHtml = buildWatchHtml({
      videoDetails: { videoId: "dQw4w9WgXcQ", title: "Test Video" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://example.com/captions",
              languageCode: "en",
              name: { simpleText: "English" },
            },
          ],
        },
      },
    });
    const captionsJson = buildJson3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "world" }] },
    ]);

    const calls: string[] = [];
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.startsWith("https://www.youtube.com/watch")) {
          return new Response(watchHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(captionsJson, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    const result = (await tool.execute(
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      buildCtx(),
    )) as {
      videoId: string;
      title: string | null;
      language: string;
      segments: Array<{ start: number; duration: number; text: string }>;
      fullText: string;
      availableLanguages: string[];
    };

    expect(result.videoId).toBe("dQw4w9WgXcQ");
    expect(result.title).toBe("Test Video");
    expect(result.language).toBe("en");
    expect(result.segments).toEqual([
      { start: 0, duration: 1, text: "Hello" },
      { start: 1, duration: 1, text: "world" },
    ]);
    expect(result.fullText).toBe("Hello world");
    expect(result.availableLanguages).toEqual(["en"]);
    expect(calls[0]).toContain("watch?v=dQw4w9WgXcQ");
    expect(calls[1]).toContain("fmt=json3");
  });

  it("appends fmt=json3 with & when the baseUrl already has a query string", async () => {
    const watchHtml = buildWatchHtml({
      videoDetails: { videoId: "abcdefghijk", title: "T" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://example.com/captions?v=abcdefghijk&lang=en",
              languageCode: "en",
            },
          ],
        },
      },
    });
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(watchHtml, { status: 200 }),
      )
      .mockImplementationOnce(async (url: string) => {
        expect(url).toBe(
          "https://example.com/captions?v=abcdefghijk&lang=en&fmt=json3",
        );
        return new Response(buildJson3([]), { status: 200 });
      });

    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    await tool.execute({ url: "abcdefghijk" }, buildCtx());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on input that cannot be resolved to a video id", async () => {
    const fetchImpl: typeof fetch = vi.fn();
    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    await expect(
      tool.execute({ url: "https://vimeo.com/123" }, buildCtx()),
    ).rejects.toThrow(/extract a YouTube video id/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a clear error when the player response is missing", async () => {
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>no marker here</html>", { status: 200 }),
      );
    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    await expect(
      tool.execute({ url: "dQw4w9WgXcQ" }, buildCtx()),
    ).rejects.toThrow(/Could not locate ytInitialPlayerResponse/);
  });

  it("throws when the video has no caption tracks", async () => {
    const watchHtml = buildWatchHtml({
      videoDetails: { videoId: "dQw4w9WgXcQ" },
      captions: {
        playerCaptionsTracklistRenderer: { captionTracks: [] },
      },
    });
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockResolvedValue(new Response(watchHtml, { status: 200 }));
    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    await expect(
      tool.execute({ url: "dQw4w9WgXcQ" }, buildCtx()),
    ).rejects.toThrow(/no caption tracks/);
  });

  it("surfaces playabilityStatus=ERROR with the reason", async () => {
    const watchHtml = buildWatchHtml({
      videoDetails: { videoId: "dQw4w9WgXcQ" },
      playabilityStatus: { status: "ERROR", reason: "Video unavailable" },
    });
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockResolvedValue(new Response(watchHtml, { status: 200 }));
    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    await expect(
      tool.execute({ url: "dQw4w9WgXcQ" }, buildCtx()),
    ).rejects.toThrow(/unplayable.*Video unavailable/);
  });

  it("honors the lang preference when picking a track", async () => {
    const watchHtml = buildWatchHtml({
      videoDetails: { videoId: "dQw4w9WgXcQ" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "https://example.com/en", languageCode: "en" },
            { baseUrl: "https://example.com/zh", languageCode: "zh-Hans" },
          ],
        },
      },
    });
    const fetchImpl: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(watchHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(buildJson3([]), { status: 200 }));
    const tool = buildYoutubeTranscriptTool({ fetchImpl });
    const result = (await tool.execute(
      { url: "dQw4w9WgXcQ", lang: "zh" },
      buildCtx(),
    )) as { language: string };
    expect(result.language).toBe("zh-Hans");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain(
      "example.com/zh",
    );
  });
});
