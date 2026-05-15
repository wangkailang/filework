import { describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../workspace/types";
import { buildWebFetchTool } from "../tools/web-fetch";

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

const fakeResponse = (
  body: string,
  init: ResponseInit & { url?: string } = {},
): Response => {
  const r = new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
  if (init.url) {
    Object.defineProperty(r, "url", { value: init.url });
  }
  return r;
};

const articleHtml = `
<!doctype html><html>
<head><title>Hello</title><meta name="description" content="World"></head>
<body><article>
  <h1>Hello</h1>
  <p>This is the first paragraph of the article — long enough for readability.</p>
  <p>Second paragraph for readability density.</p>
  <p>Third paragraph wraps it up so the heuristics fire properly.</p>
</article></body></html>
`;

describe("buildWebFetchTool", () => {
  it("registers as a safe tool", () => {
    const tool = buildWebFetchTool({
      fetchImpl: (async () => fakeResponse("")) as never,
    });
    expect(tool.name).toBe("webFetch");
    expect(tool.safety).toBe("safe");
  });

  it("returns title + markdown + raw for an HTML article", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(articleHtml, { url: "https://example.com/p" }),
    );
    const tool = buildWebFetchTool({ fetchImpl: fetchImpl as never });
    const out = (await tool.execute(
      { url: "https://example.com/p" },
      fakeCtx(),
    )) as {
      status: number;
      title: string | null;
      markdown: string;
      raw: string;
      truncated: boolean;
    };
    expect(out.status).toBe(200);
    expect(out.title).toBe("Hello");
    expect(out.markdown).toContain("first paragraph");
    expect(out.raw).toContain("<article>");
    expect(out.truncated).toBe(false);
  });

  it("truncates raw body to maxBytes", async () => {
    const big = `<html><body>${"a".repeat(500)}</body></html>`;
    const fetchImpl = vi.fn(async () => fakeResponse(big));
    const tool = buildWebFetchTool({ fetchImpl: fetchImpl as never });
    const out = (await tool.execute(
      { url: "https://example.com/", maxBytes: 100 },
      fakeCtx(),
    )) as { raw: string; truncated: boolean };
    expect(out.raw.length).toBe(100);
    expect(out.truncated).toBe(true);
  });

  it("returns empty markdown for non-HTML content type", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse('{"hello":"world"}', {
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = buildWebFetchTool({ fetchImpl: fetchImpl as never });
    const out = (await tool.execute(
      { url: "https://api.example.com/v1" },
      fakeCtx(),
    )) as { markdown: string; raw: string };
    expect(out.markdown).toBe("");
    expect(out.raw).toBe('{"hello":"world"}');
  });

  it("propagates non-2xx status without throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse("blocked", { status: 403, statusText: "Forbidden" }),
    );
    const tool = buildWebFetchTool({ fetchImpl: fetchImpl as never });
    const out = (await tool.execute(
      { url: "https://example.com/" },
      fakeCtx(),
    )) as { status: number; statusText: string };
    expect(out.status).toBe(403);
    expect(out.statusText).toBe("Forbidden");
  });

  it("forwards UA + abort signal to fetchImpl", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse("<html></html>"));
    const tool = buildWebFetchTool({ fetchImpl: fetchImpl as never });
    const ctx = fakeCtx();
    await tool.execute({ url: "https://example.com/" }, ctx);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(
      /filework-agent/,
    );
    expect(init.signal).toBe(ctx.signal);
    expect(init.redirect).toBe("follow");
  });
});
