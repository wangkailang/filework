import { describe, expect, it } from "vitest";

import { capToolResult } from "../tool-registry";

// 这里仅测试 `capToolResult` 这一个导出。完整的
// `buildEvalToolRegistry` 构造器会启动真实的工具工厂
//（文件操作、web 工具、skill）——那些由 smoke 运行做端到端测试,
// 而非本单元测试。

describe("capToolResult — top-level string", () => {
  it("passes through strings under the cap unchanged", () => {
    const s = "hello".repeat(100); // 500 个字符
    expect(capToolResult(s)).toBe(s);
  });

  it("truncates strings over the cap and appends a marker", () => {
    const s = "x".repeat(50_000);
    const out = capToolResult(s) as string;
    expect(typeof out).toBe("string");
    expect(out.length).toBeLessThan(s.length);
    expect(out).toMatch(/\.\.\.\(truncated, \d+ more bytes\)$/);
    expect(out.startsWith("x".repeat(30_000))).toBe(true);
  });
});

describe("capToolResult — objects under the cap", () => {
  it("returns the same reference (no clone) for small objects", () => {
    const o = { url: "https://example.com", status: 200, body: "small" };
    expect(capToolResult(o)).toBe(o);
  });

  it("treats null and primitives as terminals", () => {
    expect(capToolResult(null)).toBeNull();
    expect(capToolResult(42)).toBe(42);
    expect(capToolResult(true)).toBe(true);
    expect(capToolResult(undefined)).toBeUndefined();
  });

  it("preserves number, boolean, and null fields in a small object", () => {
    const o = { count: 3, ok: true, nothing: null, text: "hi" };
    expect(capToolResult(o)).toEqual(o);
  });
});

describe("capToolResult — objects over the cap", () => {
  it("clips long string leaves but preserves structure", () => {
    const big = "y".repeat(20_000);
    const small = "kept";
    const input = {
      url: "https://example.com",
      markdown: big,
      meta: { byline: small, summary: big },
      images: ["https://example.com/a.png"],
    };
    const out = capToolResult(input) as typeof input;
    expect(out.url).toBe("https://example.com");
    expect(out.meta.byline).toBe(small);
    expect(out.images).toEqual(["https://example.com/a.png"]);
    expect(out.markdown.length).toBeLessThan(big.length);
    expect(out.markdown).toMatch(/truncated/);
    expect(out.meta.summary.length).toBeLessThan(big.length);
  });

  it("clips strings inside arrays", () => {
    const big = "z".repeat(15_000);
    const out = capToolResult({
      docs: [
        { title: "a", body: big },
        { title: "b", body: big },
        { title: "c", body: big },
      ],
    }) as { docs: Array<{ title: string; body: string }> };
    expect(out.docs).toHaveLength(3);
    expect(out.docs[0].title).toBe("a");
    expect(out.docs[1].body.length).toBeLessThan(big.length);
    expect(out.docs[2].body).toMatch(/truncated/);
  });

  it("does not touch short strings even when overall result is over the cap", () => {
    const big = "q".repeat(40_000);
    const out = capToolResult({
      shortLabel: "OK",
      longBody: big,
    }) as { shortLabel: string; longBody: string };
    expect(out.shortLabel).toBe("OK");
    expect(out.longBody.length).toBeLessThan(big.length);
  });
});

describe("capToolResult — unserialisable input", () => {
  it("returns input unchanged when JSON.stringify throws (circular)", () => {
    const o: Record<string, unknown> = { name: "circular" };
    o.self = o;
    expect(capToolResult(o)).toBe(o);
  });
});
