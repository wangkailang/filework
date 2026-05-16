/**
 * webSearch — Discovery tool backed by the Tavily Search API.
 *
 * The agent uses this when the user asks a question without supplying
 * a URL. Tavily returns ranked results (title / url / content / score)
 * plus an optional one-shot synthesized answer — often enough to reply
 * without deep-fetching anything. The agent escalates to `webFetch`
 * (Layer 1) only when it needs the full article.
 *
 * Requires a Tavily API key stored as a `tavily_pat` credential.
 * Free tier: 1000 searches/month — generous for personal use.
 */
import { z } from "zod/v4";

import type { ToolDefinition } from "../tool-registry";

export interface WebSearchDeps {
  fetchImpl: typeof fetch;
  /** Returns the most recent Tavily API key, or null when none configured. */
  resolveTavilyToken: () => Promise<string | null>;
}

const inputSchema = z.object({
  query: z.string().min(1).describe("Natural-language search query."),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Default 5."),
  searchDepth: z
    .enum(["basic", "advanced"])
    .optional()
    .describe(
      "'advanced' fetches deeper content per result; costs more credits.",
    ),
  includeAnswer: z
    .boolean()
    .optional()
    .describe(
      "If true (default), Tavily synthesizes a one-shot answer from the top results.",
    ),
  includeImages: z
    .boolean()
    .optional()
    .describe(
      "Set true when the user wants to SEE images (e.g. '找几张猫的图', 'show me photos of X'). " +
        "Returns an `images` array; the renderer will display them as a clickable gallery automatically.",
    ),
  imageDescriptions: z
    .boolean()
    .optional()
    .describe(
      "Only matters when includeImages is true. Adds Tavily-generated captions per image. Costs more credits.",
    ),
});

interface RawTavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

type RawTavilyImage = string | { url?: string; description?: string };

interface RawTavilyResponse {
  answer?: string | null;
  results?: RawTavilyResult[];
  images?: RawTavilyImage[];
}

export const buildWebSearchTool = (deps: WebSearchDeps): ToolDefinition => ({
  name: "webSearch",
  description:
    "Search the web with a natural-language question. Returns ranked URLs + snippets + (often) a synthesized answer. " +
    "Use this when the user asks something and didn't supply a URL — the answer/snippets are usually enough; " +
    "deep-fetch via `webFetch` only when you need the full article. " +
    "When the user wants to SEE pictures (e.g. '搜几张...的图片', 'show me photos of ...'), pass `includeImages: true`; " +
    "the returned `images` array is rendered as a clickable gallery — you don't need to repeat the URLs in your text reply.",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const {
      query,
      maxResults,
      searchDepth,
      includeAnswer,
      includeImages,
      imageDescriptions,
    } = args as z.infer<typeof inputSchema>;
    const token = await deps.resolveTavilyToken();
    if (!token) {
      return {
        error:
          "No Tavily API key configured. Open Settings → Credentials → Add Credential → kind: Tavily.",
      };
    }
    const res = await deps.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        query,
        max_results: maxResults ?? 5,
        search_depth: searchDepth ?? "basic",
        include_answer: includeAnswer ?? true,
        include_images: includeImages ?? false,
        include_image_descriptions:
          (includeImages ?? false) && (imageDescriptions ?? false),
      }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Tavily ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as RawTavilyResponse;
    const images = (json.images ?? [])
      .map((img): { url: string; description?: string } | null => {
        if (typeof img === "string") {
          return img ? { url: img } : null;
        }
        if (img && typeof img === "object" && typeof img.url === "string") {
          return img.description
            ? { url: img.url, description: img.description }
            : { url: img.url };
        }
        return null;
      })
      .filter((x): x is { url: string; description?: string } => x !== null);
    return {
      answer: json.answer ?? null,
      results: (json.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        score: typeof r.score === "number" ? r.score : null,
      })),
      images,
    };
  },
});
