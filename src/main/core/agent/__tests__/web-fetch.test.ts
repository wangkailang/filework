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

describe("buildWebFetchTool — PDF handling", () => {
  const okExtract = (text: string, pages = 1) =>
    vi.fn(async () => ({ ok: true as const, text, pages, truncated: false }));

  it("extracts text from an application/pdf response and omits raw binary", async () => {
    const extractPdf = okExtract("Federal Register page text", 8);
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 binary…", {
        headers: { "content-type": "application/pdf" },
        url: "https://example.com/doc.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
    });
    const out = (await tool.execute(
      { url: "https://example.com/doc.pdf" },
      fakeCtx(),
    )) as {
      contentType: string;
      markdown: string;
      raw: string;
      pages?: number;
      truncated: boolean;
      error?: string;
    };
    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(out.markdown).toBe("Federal Register page text");
    expect(out.raw).toBe("");
    expect(out.pages).toBe(8);
    expect(out.contentType).toContain("pdf");
    expect(out.error).toBeUndefined();
  });

  it("downloads PDFs larger than the HTML byte cap instead of refusing", async () => {
    const extractPdf = okExtract("big pdf text");
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: {
          "content-type": "application/pdf",
          "content-length": "17025841",
        },
        url: "https://archives.example.gov/issue.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
    });
    const out = (await tool.execute(
      { url: "https://archives.example.gov/issue.pdf" },
      fakeCtx(),
    )) as { markdown: string; error?: string };
    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(out.markdown).toBe("big pdf text");
    expect(out.error).toBeUndefined();
  });

  it("detects PDFs by .pdf URL even when content-type is generic", async () => {
    const extractPdf = okExtract("octet-stream pdf text");
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: { "content-type": "application/octet-stream" },
        url: "https://example.com/files/report.pdf?v=2",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
    });
    const out = (await tool.execute(
      { url: "https://example.com/files/report.pdf?v=2" },
      fakeCtx(),
    )) as { markdown: string };
    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(out.markdown).toBe("octet-stream pdf text");
  });

  it("surfaces a PDF extraction failure as an error field", async () => {
    const extractPdf = vi.fn(async () => ({
      ok: false as const,
      error: "encrypted PDF",
    }));
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: { "content-type": "application/pdf" },
        url: "https://example.com/x.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
    });
    const out = (await tool.execute(
      { url: "https://example.com/x.pdf" },
      fakeCtx(),
    )) as { markdown: string; error?: string };
    expect(out.markdown).toBe("");
    expect(out.error).toContain("encrypted PDF");
  });

  it("refuses PDFs beyond the PDF download cap without calling the extractor", async () => {
    const extractPdf = okExtract("never reached");
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: {
          "content-type": "application/pdf",
          "content-length": "60000000",
        },
        url: "https://example.com/huge.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
    });
    const out = (await tool.execute(
      { url: "https://example.com/huge.pdf" },
      fakeCtx(),
    )) as { error?: string; truncated: boolean };
    expect(extractPdf).not.toHaveBeenCalled();
    expect(out.truncated).toBe(true);
    expect(out.error).toMatch(/too large/i);
  });

  // 用真实的多块 ReadableStream body,且不带 content-length —— 模拟 chunked
  // 传输,逼出"无 content-length 时无界缓冲"的路径。
  const pdfStream = (chunks: string[], url: string): Response => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const r = new Response(stream, {
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperty(r, "url", { value: url });
    return r;
  };

  it("aborts a chunked PDF stream once it exceeds the cap (no content-length)", async () => {
    const extractPdf = okExtract("never reached");
    const fetchImpl = vi.fn(async () =>
      pdfStream(
        ["a".repeat(30), "b".repeat(30), "c".repeat(30)],
        "https://example.com/stream.pdf",
      ),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
      pdfMaxBytes: 50,
    });
    const out = (await tool.execute(
      { url: "https://example.com/stream.pdf" },
      fakeCtx(),
    )) as { error?: string; truncated: boolean };
    expect(extractPdf).not.toHaveBeenCalled();
    expect(out.truncated).toBe(true);
    expect(out.error).toMatch(/too large/i);
  });

  it("reassembles multi-chunk PDF bytes before extracting (no content-length)", async () => {
    let received: Uint8Array | undefined;
    const extractPdf = vi.fn(async (data: Uint8Array) => {
      received = data;
      return { ok: true as const, text: "ok", pages: 1, truncated: false };
    });
    const chunks = ["%PDF-1.4 ", "hello ", "world"];
    const fetchImpl = vi.fn(async () =>
      pdfStream(chunks, "https://example.com/multi.pdf"),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
      pdfMaxBytes: 1000,
    });
    await tool.execute({ url: "https://example.com/multi.pdf" }, fakeCtx());
    expect(received).toBeDefined();
    expect(new TextDecoder().decode(received)).toBe(chunks.join(""));
  });

  it("routes a PDF + query through searchPdf and returns matched pages", async () => {
    const extractPdf = okExtract("full document text");
    let receivedQuery: string | undefined;
    const searchPdf = vi.fn(async (_data: Uint8Array, query: string) => {
      receivedQuery = query;
      return {
        ok: true as const,
        markdown: "page 12 body",
        matchedPages: [12],
        total: 40,
        truncated: true,
      };
    });
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: { "content-type": "application/pdf" },
        url: "https://example.com/big.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
      searchPdf,
    });
    const out = (await tool.execute(
      { url: "https://example.com/big.pdf", query: "net income 1959" },
      fakeCtx(),
    )) as {
      markdown: string;
      matchedPages?: number[];
      pages?: number;
      truncated: boolean;
    };
    expect(searchPdf).toHaveBeenCalledTimes(1);
    expect(receivedQuery).toBe("net income 1959");
    expect(extractPdf).not.toHaveBeenCalled();
    expect(out.markdown).toBe("page 12 body");
    expect(out.matchedPages).toEqual([12]);
    expect(out.pages).toBe(40);
    expect(out.truncated).toBe(true);
  });

  it("uses full-text extraction (not search) when no query is given", async () => {
    const extractPdf = okExtract("full document text", 3);
    const searchPdf = vi.fn();
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: { "content-type": "application/pdf" },
        url: "https://example.com/doc.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      extractPdf,
      searchPdf: searchPdf as never,
    });
    const out = (await tool.execute(
      { url: "https://example.com/doc.pdf" },
      fakeCtx(),
    )) as { markdown: string };
    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(searchPdf).not.toHaveBeenCalled();
    expect(out.markdown).toBe("full document text");
  });

  it("surfaces a PDF search failure as an error field", async () => {
    const searchPdf = vi.fn(async () => ({
      ok: false as const,
      error: "search backend down",
    }));
    const fetchImpl = vi.fn(async () =>
      fakeResponse("%PDF-1.4 …", {
        headers: { "content-type": "application/pdf" },
        url: "https://example.com/doc.pdf",
      }),
    );
    const tool = buildWebFetchTool({
      fetchImpl: fetchImpl as never,
      searchPdf,
    });
    const out = (await tool.execute(
      { url: "https://example.com/doc.pdf", query: "anything" },
      fakeCtx(),
    )) as { markdown: string; error?: string };
    expect(out.markdown).toBe("");
    expect(out.error).toContain("search backend down");
  });
});
