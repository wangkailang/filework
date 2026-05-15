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
});

interface RawTavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface RawTavilyResponse {
  answer?: string | null;
  results?: RawTavilyResult[];
}

export const buildWebSearchTool = (deps: WebSearchDeps): ToolDefinition => ({
  name: "webSearch",
  description:
    "Search the web with a natural-language question. Returns ranked URLs + snippets + (often) a synthesized answer. " +
    "Use this when the user asks something and didn't supply a URL — the answer/snippets are usually enough; " +
    "deep-fetch via `webFetch` only when you need the full article.",
  safety: "safe",
  inputSchema,
  execute: async (args, ctx) => {
    const { query, maxResults, searchDepth, includeAnswer } = args as z.infer<
      typeof inputSchema
    >;
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
      }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Tavily ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as RawTavilyResponse;
    return {
      answer: json.answer ?? null,
      results: (json.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        score: typeof r.score === "number" ? r.score : null,
      })),
    };
  },
});
