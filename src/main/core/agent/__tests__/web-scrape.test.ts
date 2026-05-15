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
