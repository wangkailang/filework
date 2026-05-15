import { describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../workspace/types";
import { buildWebSearchTool } from "../tools/web-search";

const fakeWorkspace = (): Workspace =>
  ({
    id: "local:/tmp",
    kind: "local",
    root: "/tmp",
    fs: {} as never,
    exec: {} as never,
  }) as Workspace;

const fakeCtx = () => ({
  workspace: fakeWorkspace(),
  signal: new AbortController().signal,
  toolCallId: "t-1",
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("buildWebSearchTool", () => {
  it("returns structured error when no Tavily token is configured", async () => {
    const fetchImpl = vi.fn();
    const tool = buildWebSearchTool({
      fetchImpl: fetchImpl as never,
      resolveTavilyToken: async () => null,
    });
    const out = (await tool.execute({ query: "anything" }, fakeCtx())) as {
      error?: string;
    };
    expect(out.error).toMatch(/No Tavily API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses Tavily search response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        answer: "Yes, it works.",
        results: [
          {
            title: "A",
            url: "https://a.test",
            content: "snippet A",
            score: 0.9,
          },
          {
            title: "B",
            url: "https://b.test",
            content: "snippet B",
            score: 0.7,
          },
        ],
      }),
    );
    const tool = buildWebSearchTool({
      fetchImpl: fetchImpl as never,
      resolveTavilyToken: async () => "tvly-test",
    });
    const out = (await tool.execute(
      { query: "does it work?", maxResults: 2 },
      fakeCtx(),
    )) as {
      answer: string | null;
      results: Array<{
        title: string;
        url: string;
        snippet: string;
        score: number | null;
      }>;
    };
    expect(out.answer).toBe("Yes, it works.");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toEqual({
      title: "A",
      url: "https://a.test",
      snippet: "snippet A",
      score: 0.9,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.api_key).toBe("tvly-test");
    expect(body.query).toBe("does it work?");
    expect(body.max_results).toBe(2);
  });

  it("throws on non-2xx Tavily response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("rate limit", { status: 429, statusText: "Too Many" }),
    );
    const tool = buildWebSearchTool({
      fetchImpl: fetchImpl as never,
      resolveTavilyToken: async () => "tvly-test",
    });
    await expect(tool.execute({ query: "x" }, fakeCtx())).rejects.toThrow(
      /Tavily 429/,
    );
  });
});
