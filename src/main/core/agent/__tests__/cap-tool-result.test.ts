import { describe, expect, it } from "vitest";

import { capToolResult } from "../cap-tool-result";

describe("capToolResult", () => {
  it("leaves small results untouched (same reference)", () => {
    const r = { markdown: "ok", n: 3, flag: true };
    expect(capToolResult(r)).toBe(r);
  });

  it("passes through primitives", () => {
    expect(capToolResult(42)).toBe(42);
    expect(capToolResult(null)).toBeNull();
    expect(capToolResult(undefined)).toBeUndefined();
  });

  it("clamps an oversized string field but keeps structure", () => {
    const big = "X".repeat(300_000);
    const out = capToolResult({ markdown: big, title: "t" }) as {
      markdown: string;
      title: string;
    };
    expect(out.title).toBe("t");
    expect(out.markdown.length).toBeLessThan(big.length);
    expect(out.markdown).toContain("[truncated");
  });

  it("clamps each oversized string head+tail", () => {
    const big = `${"A".repeat(250_000)}TAIL`;
    const out = capToolResult({ raw: big }) as { raw: string };
    expect(out.raw.startsWith("A")).toBe(true);
    expect(out.raw.endsWith("TAIL")).toBe(true);
    expect(out.raw).toContain("[truncated");
  });

  it("clamps strings nested in arrays", () => {
    const big = "Y".repeat(300_000);
    const out = capToolResult({ items: [{ text: big }] }) as {
      items: Array<{ text: string }>;
    };
    expect(out.items[0].text.length).toBeLessThan(big.length);
  });

  it("falls back to a truncated blob for array-heavy results over the ceiling", () => {
    // Many small strings: per-string clamp can't shrink them, total ceiling does.
    const segments = Array.from({ length: 20_000 }, (_, i) => `seg ${i} text`);
    const out = capToolResult({ segments }, { ceiling: 50_000 });
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeLessThanOrEqual(50_000);
  });
});
