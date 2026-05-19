import { describe, expect, it } from "vitest";
import { mapUsage } from "../agent-loop";

describe("mapUsage — reasoning token extraction", () => {
  it("returns undefined when raw is not an object", () => {
    expect(mapUsage(undefined)).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage(42)).toBeUndefined();
  });

  it("extracts reasoningTokens from v6 nested outputTokenDetails", () => {
    const u = mapUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      outputTokenDetails: { reasoningTokens: 30, textTokens: 20 },
    });
    expect(u?.reasoningTokens).toBe(30);
    expect(u?.inputTokens).toBe(100);
    expect(u?.outputTokens).toBe(50);
  });

  it("falls back to the deprecated flat reasoningTokens field", () => {
    const u = mapUsage({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 42,
    });
    expect(u?.reasoningTokens).toBe(42);
  });

  it("prefers nested over flat when both are present", () => {
    const u = mapUsage({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 999, // legacy — should be ignored
      outputTokenDetails: { reasoningTokens: 30 },
    });
    expect(u?.reasoningTokens).toBe(30);
  });

  it("returns null reasoningTokens when neither field is set (non-reasoning model)", () => {
    const u = mapUsage({ inputTokens: 100, outputTokens: 50 });
    expect(u?.reasoningTokens).toBeNull();
  });

  it("computes totalTokens when missing but inputs/outputs are present", () => {
    const u = mapUsage({ inputTokens: 100, outputTokens: 50 });
    expect(u?.totalTokens).toBe(150);
  });

  it("preserves cachedInputTokens → cacheReadTokens mapping", () => {
    const u = mapUsage({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 80,
    });
    expect(u?.cacheReadTokens).toBe(80);
  });
});
