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
  it("注册为 safe 工具", () => {
    const tool = buildWebFetchTool({
      fetchImpl: (async () => fakeResponse("")) as never,
    });
    expect(tool.name).toBe("webFetch");
    expect(tool.safety).toBe("safe");
  });

  it("对 HTML 文章返回 title + markdown,并省略冗余 raw", async () => {
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
    // markdown 已承载内容 → 丢弃 raw 以避免 token 翻倍。
    expect(out.raw).toBe("");
    expect(out.truncated).toBe(false);
  });

  it("projects a compact model-visible web fetch result", async () => {
    const tool = buildWebFetchTool({
      fetchImpl: (async () => fakeResponse("")) as never,
    });
    const projected = await tool.toModelOutput?.({
      toolCallId: "fetch-1",
      input: { url: "https://example.com/article" },
      output: {
        status: 200,
        statusText: "OK",
        url: "https://example.com/article",
        contentType: "text/html",
        title: "A very useful article",
        excerpt: "Short description",
        markdown: `${"main body ".repeat(2000)}secret-tail`,
        raw: "",
        images: Array.from({ length: 20 }, (_, i) => ({
          url: `https://example.com/${i}.png`,
        })),
        videos: [],
        meta: { siteName: "Example" },
        structuredData: [{ very: "large" }],
        truncated: true,
      },
    });

    expect(projected).toMatchObject({ type: "text" });
    const value = (projected as { value: string }).value;
    expect(value).toContain("webFetch https://example.com/article");
    expect(value).toContain("Status: 200 OK");
    expect(value).toContain("Title: A very useful article");
    expect(value).toContain("Images: 20");
    expect(value).not.toContain("secret-tail");
    expect(value).not.toContain("structuredData");
    expect(value.length).toBeLessThan(13_000);
  });

  it("将非 HTML 正文(raw)截断到 maxBytes", async () => {
    const big = "a".repeat(500);
    const fetchImpl = vi.fn(async () =>
      fakeResponse(big, { headers: { "content-type": "text/plain" } }),
    );
    const tool = buildWebFetchTool({ fetchImpl: fetchImpl as never });
    const out = (await tool.execute(
      { url: "https://example.com/x.txt", maxBytes: 100 },
      fakeCtx(),
    )) as { raw: string; truncated: boolean };
    expect(out.raw.length).toBe(100);
    expect(out.truncated).toBe(true);
  });

  it("对非 HTML content-type 返回空 markdown", async () => {
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

  it("透传非 2xx 状态码且不抛异常", async () => {
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

  it("把 UA 与 abort signal 透传给 fetchImpl", async () => {
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

describe("buildWebFetchTool — PDF 处理", () => {
  const okExtract = (text: string, pages = 1) =>
    vi.fn(async () => ({ ok: true as const, text, pages, truncated: false }));

  it("从 application/pdf 响应抽取文本,且 raw 不含二进制", async () => {
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

  it("下载超过 HTML 字节上限的 PDF 而非拒绝", async () => {
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

  it("content-type 通用时仍按 .pdf URL 识别 PDF", async () => {
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

  it("PDF 抽取失败时以 error 字段暴露", async () => {
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

  it("超过 PDF 下载上限时拒绝且不调用抽取器", async () => {
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

  it("无 content-length 时,分块 PDF 流超过上限即中止", async () => {
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

  it("抽取前重组多块 PDF 字节(无 content-length)", async () => {
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

  it("带 query 的 PDF 经 searchPdf 路由并返回命中页", async () => {
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

  it("未给 query 时使用全文抽取(而非搜索)", async () => {
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

  it("PDF 搜索失败时以 error 字段暴露", async () => {
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
