import { describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../workspace/types";
import { buildWebScrapeTool } from "../tools/web-scrape";

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

describe("buildWebScrapeTool", () => {
  it("returns structured error when no Firecrawl token is configured", async () => {
    const fetchImpl = vi.fn();
    const tool = buildWebScrapeTool({
      fetchImpl: fetchImpl as never,
      resolveFirecrawlToken: async () => null,
    });
    const out = (await tool.execute(
      { url: "https://example.com/" },
      fakeCtx(),
    )) as { error?: string };
    expect(out.error).toMatch(/No Firecrawl API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses Firecrawl scrape response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          markdown: "# Hello\n\nContent.",
          html: "<h1>Hello</h1>",
          metadata: { title: "Hello", description: "A page" },
        },
      }),
    );
    const tool = buildWebScrapeTool({
      fetchImpl: fetchImpl as never,
      resolveFirecrawlToken: async () => "fc-test",
    });
    const out = (await tool.execute(
      { url: "https://example.com/" },
      fakeCtx(),
    )) as {
      title: string | null;
      excerpt: string | null;
      markdown: string;
      html: string | null;
    };
    expect(out.title).toBe("Hello");
    expect(out.excerpt).toBe("A page");
    expect(out.markdown).toContain("# Hello");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.firecrawl.dev/v1/scrape");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer fc-test",
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.url).toBe("https://example.com/");
    expect(body.formats).toEqual(["markdown"]);
  });

  it("projects compact model-visible scrape output", async () => {
    const tool = buildWebScrapeTool({
      fetchImpl: vi.fn() as never,
      resolveFirecrawlToken: async () => "fc-test",
    });
    const projected = await tool.toModelOutput?.({
      toolCallId: "scrape-1",
      input: { url: "https://example.com/blocked-page" },
      output: {
        status: 200,
        url: "https://example.com/blocked-page",
        title: "Blocked Page",
        excerpt: "Rendered by Firecrawl",
        markdown: `${"scraped body ".repeat(2000)}markdown-tail`,
        html: `${"<div>noisy</div>".repeat(2000)}html-tail`,
        meta: { siteName: "Example" },
        images: [],
        videos: [],
        structuredData: [{ noisy: true }],
      },
    });

    expect(projected).toMatchObject({ type: "text" });
    const value = (projected as { value: string }).value;
    expect(value).toContain("webScrape https://example.com/blocked-page");
    expect(value).toContain("Title: Blocked Page");
    expect(value).toContain("Images: 0");
    expect(value).not.toContain("markdown-tail");
    expect(value).not.toContain("html-tail");
    expect(value).not.toContain("structuredData");
    expect(value.length).toBeLessThan(13_000);
  });

  it("throws when Firecrawl returns non-ok", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("nope", { status: 402, statusText: "Payment Required" }),
    );
    const tool = buildWebScrapeTool({
      fetchImpl: fetchImpl as never,
      resolveFirecrawlToken: async () => "fc-test",
    });
    await expect(
      tool.execute({ url: "https://example.com/" }, fakeCtx()),
    ).rejects.toThrow(/Firecrawl 402/);
  });

  it("throws when Firecrawl JSON contains error field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, error: "blocked-by-robots" }),
    );
    const tool = buildWebScrapeTool({
      fetchImpl: fetchImpl as never,
      resolveFirecrawlToken: async () => "fc-test",
    });
    await expect(
      tool.execute({ url: "https://example.com/" }, fakeCtx()),
    ).rejects.toThrow(/blocked-by-robots/);
  });
});
