import { describe, expect, it, vi } from "vitest";

import { createProxyAwareFetch } from "../proxy-fetch";

/**
 * `createProxyAwareFetch` returns a `fetch`-shaped function that picks
 * a dispatcher per URL via the injected `resolveProxy`. We don't open
 * real sockets — `agentFactory` is stubbed to return marker objects so
 * we can assert which one each request received.
 */

interface StubDispatcher {
  /** Stable id so tests can assert reuse + selection. */
  readonly tag: string;
}

const buildStubFactory = () => {
  const created: Array<{ proxyUrl: string | null; agent: StubDispatcher }> = [];
  const factory = (proxyUrl: string | null): StubDispatcher => {
    const agent = { tag: proxyUrl ?? "direct" };
    created.push({ proxyUrl, agent });
    // biome-ignore lint/suspicious/noExplicitAny: stub for undici Dispatcher
    return agent as any;
  };
  return { factory, created };
};

const dispatcherFromInit = (init: RequestInit | undefined): unknown =>
  // biome-ignore lint/suspicious/noExplicitAny: undici extends RequestInit
  (init as any)?.dispatcher;

describe("createProxyAwareFetch", () => {
  it("routes DIRECT requests through the direct agent", async () => {
    const resolveProxy = vi.fn(async () => "DIRECT");
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const { factory, created } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
    });

    await fetchImpl("https://gitlab.example.com/api");

    expect(resolveProxy).toHaveBeenCalledWith("https://gitlab.example.com/api");
    expect(created).toEqual([{ proxyUrl: null, agent: { tag: "direct" } }]);
    const init = baseFetch.mock.calls[0]?.[1];
    expect(dispatcherFromInit(init)).toEqual({ tag: "direct" });
  });

  it("routes PROXY requests through a ProxyAgent for that proxy URL", async () => {
    const resolveProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const { factory } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
    });

    await fetchImpl("https://api.github.com/user/repos");
    const init = baseFetch.mock.calls[0]?.[1];
    expect(dispatcherFromInit(init)).toEqual({ tag: "http://127.0.0.1:7890" });
  });

  it("caches dispatchers — same proxy URL reuses the same agent", async () => {
    const resolveProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const { factory, created } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
    });

    await fetchImpl("https://api.github.com/a");
    await fetchImpl("https://api.github.com/b");

    expect(created).toHaveLength(1);
    const d1 = dispatcherFromInit(baseFetch.mock.calls[0]?.[1]);
    const d2 = dispatcherFromInit(baseFetch.mock.calls[1]?.[1]);
    expect(d1).toBe(d2);
  });

  it("mixes direct + proxy dispatchers when hosts route differently", async () => {
    const resolveProxy = vi.fn(async (url: string) =>
      url.includes("github") ? "PROXY 127.0.0.1:7890" : "DIRECT",
    );
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const { factory } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
    });

    await fetchImpl("https://gitlab.quguazhan.com/api/v4/projects");
    await fetchImpl("https://api.github.com/user");

    const gitlabDispatcher = dispatcherFromInit(baseFetch.mock.calls[0]?.[1]);
    const githubDispatcher = dispatcherFromInit(baseFetch.mock.calls[1]?.[1]);
    expect(gitlabDispatcher).toEqual({ tag: "direct" });
    expect(githubDispatcher).toEqual({ tag: "http://127.0.0.1:7890" });
  });

  it("falls back to direct when resolveProxy throws", async () => {
    const resolveProxy = vi.fn(async () => {
      throw new Error("session destroyed");
    });
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const warn = vi.fn();
    const { factory } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
      warn,
    });

    await fetchImpl("https://gitlab.example.com/api");
    const init = baseFetch.mock.calls[0]?.[1];
    expect(dispatcherFromInit(init)).toEqual({ tag: "direct" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/session destroyed/);
  });

  it("accepts URL and Request inputs (not just strings)", async () => {
    const resolveProxy = vi.fn(async () => "DIRECT");
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const { factory } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
    });

    await fetchImpl(new URL("https://example.com/a"));
    await fetchImpl(new Request("https://example.com/b"));

    expect(resolveProxy).toHaveBeenNthCalledWith(1, "https://example.com/a");
    expect(resolveProxy).toHaveBeenNthCalledWith(2, "https://example.com/b");
  });

  it("preserves caller-supplied init fields (headers, body, signal)", async () => {
    const resolveProxy = vi.fn(async () => "DIRECT");
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const { factory } = buildStubFactory();

    const fetchImpl = createProxyAwareFetch({
      resolveProxy,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      baseFetch: baseFetch as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      agentFactory: factory as any,
    });

    await fetchImpl("https://example.com/a", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: "payload",
    });

    const init = baseFetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer token" });
    expect(init?.body).toBe("payload");
    expect(dispatcherFromInit(init)).toEqual({ tag: "direct" });
  });
});
