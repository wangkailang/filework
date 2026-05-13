import { describe, expect, it, vi } from "vitest";

import { bootstrapProxy, parseChromeProxyList } from "../proxy-bootstrap";

describe("parseChromeProxyList", () => {
  it.each([
    ["DIRECT", null],
    ["", null],
    ["PROXY 127.0.0.1:7890", "http://127.0.0.1:7890"],
    ["PROXY 127.0.0.1:7890; DIRECT", "http://127.0.0.1:7890"],
    ["DIRECT; PROXY 10.0.0.1:8080", "http://10.0.0.1:8080"],
    ["proxy lower.example:3128", "http://lower.example:3128"],
    ["SOCKS5 127.0.0.1:7891; DIRECT", null],
    ["HTTPS 127.0.0.1:443", null],
  ])("parses %j -> %j", (raw, expected) => {
    expect(parseChromeProxyList(raw)).toBe(expected);
  });
});

describe("bootstrapProxy", () => {
  it("uses preset HTTPS_PROXY env without probing", async () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://10.0.0.1:9000" };
    const resolveProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const setDispatcher = vi.fn();
    const log = vi.fn();

    const result = await bootstrapProxy({
      resolveProxy,
      env,
      setDispatcher,
      log,
    });

    expect(result).toEqual({
      source: "env",
      proxyUrl: "http://10.0.0.1:9000",
    });
    expect(resolveProxy).not.toHaveBeenCalled();
    expect(setDispatcher).toHaveBeenCalledTimes(1);
    expect(env.HTTPS_PROXY).toBe("http://10.0.0.1:9000");
  });

  it("seeds env from system proxy probe when env is empty", async () => {
    const env: NodeJS.ProcessEnv = {};
    const resolveProxy = vi.fn(async () => "PROXY 127.0.0.1:7890; DIRECT");
    const setDispatcher = vi.fn();
    const log = vi.fn();

    const result = await bootstrapProxy({
      resolveProxy,
      env,
      setDispatcher,
      log,
    });

    expect(result).toEqual({
      source: "system",
      proxyUrl: "http://127.0.0.1:7890",
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(setDispatcher).toHaveBeenCalledTimes(1);
  });

  it("preserves existing NO_PROXY when system proxy is found", async () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: "internal.corp" };
    const resolveProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");

    await bootstrapProxy({
      resolveProxy,
      env,
      setDispatcher: vi.fn(),
      log: vi.fn(),
    });

    expect(env.NO_PROXY).toBe("internal.corp");
  });

  it("returns source:none and leaves env untouched when DIRECT", async () => {
    const env: NodeJS.ProcessEnv = {};
    const resolveProxy = vi.fn(async () => "DIRECT");
    const setDispatcher = vi.fn();

    const result = await bootstrapProxy({
      resolveProxy,
      env,
      setDispatcher,
      log: vi.fn(),
    });

    expect(result).toEqual({ source: "none", proxyUrl: null });
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(setDispatcher).toHaveBeenCalledTimes(1);
  });

  it("returns source:none and logs when SOCKS-only is returned", async () => {
    const env: NodeJS.ProcessEnv = {};
    const log = vi.fn();

    await bootstrapProxy({
      resolveProxy: async () => "SOCKS5 127.0.0.1:7891",
      env,
      setDispatcher: vi.fn(),
      log,
    });

    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("SOCKS5 127.0.0.1:7891"),
    );
  });

  it("swallows resolveProxy errors", async () => {
    const env: NodeJS.ProcessEnv = {};
    const log = vi.fn();

    const result = await bootstrapProxy({
      resolveProxy: async () => {
        throw new Error("session not ready");
      },
      env,
      setDispatcher: vi.fn(),
      log,
    });

    expect(result).toEqual({ source: "none", proxyUrl: null });
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("session not ready"),
    );
  });
});
