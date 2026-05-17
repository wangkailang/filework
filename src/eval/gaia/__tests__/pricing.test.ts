import { describe, expect, it } from "vitest";

import {
  calculateCost,
  formatCost,
  getModelPrice,
  MODEL_PRICES,
  normalizeModelId,
} from "../pricing";

// ─── normalizeModelId ────────────────────────────────────────────────

describe("normalizeModelId", () => {
  it("strips an 8-digit date suffix", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20251022")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("strips the -latest alias", () => {
    expect(normalizeModelId("claude-sonnet-4-6-latest")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("is a no-op for ids that need no normalisation", () => {
    expect(normalizeModelId("gpt-4o")).toBe("gpt-4o");
    expect(normalizeModelId("deepseek-chat")).toBe("deepseek-chat");
  });

  it("doesn't strip a year if it isn't 4 digits", () => {
    expect(normalizeModelId("model-2025-mini")).toBe("model-2025-mini");
  });
});

// ─── getModelPrice ───────────────────────────────────────────────────

describe("getModelPrice", () => {
  it("returns the table row for known models", () => {
    expect(getModelPrice("claude-sonnet-4-6")).toEqual(
      MODEL_PRICES["claude-sonnet-4-6"],
    );
  });

  it("normalises before lookup so dated ids resolve", () => {
    expect(getModelPrice("claude-sonnet-4-7-20260104")).toEqual(
      MODEL_PRICES["claude-sonnet-4-7"],
    );
  });

  it("returns null for unknown models", () => {
    expect(getModelPrice("nonexistent-model")).toBeNull();
  });
});

// ─── calculateCost ───────────────────────────────────────────────────

describe("calculateCost", () => {
  it("computes input + output cost per million tokens", () => {
    // sonnet-4-6: $3 in / $15 out per MTok
    // 100k input + 20k output = (100_000 * 3 + 20_000 * 15) / 1e6
    //                         = (300_000 + 300_000) / 1e6 = 0.6
    const cost = calculateCost("claude-sonnet-4-6", {
      input: 100_000,
      output: 20_000,
      total: 120_000,
    });
    expect(cost).toBeCloseTo(0.6, 6);
  });

  it("handles dated model ids via normalisation", () => {
    const cost = calculateCost("claude-sonnet-4-6-20251022", {
      input: 1_000_000,
      output: 1_000_000,
      total: 2_000_000,
    });
    expect(cost).toBeCloseTo(18, 6); // 3 + 15
  });

  it("returns null for unpriced models (distinguishable from $0)", () => {
    expect(
      calculateCost("nonexistent-model", { input: 1, output: 1, total: 2 }),
    ).toBeNull();
  });

  it("returns null when usage is missing", () => {
    expect(calculateCost("claude-sonnet-4-6", undefined)).toBeNull();
  });

  it("returns 0 for zero-usage runs on a priced model", () => {
    expect(
      calculateCost("claude-sonnet-4-6", { input: 0, output: 0, total: 0 }),
    ).toBe(0);
  });
});

// ─── formatCost ──────────────────────────────────────────────────────

describe("formatCost", () => {
  it("renders null / undefined as em-dash", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
  });

  it("renders zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("renders sub-cent values as <$0.01 instead of $0.00", () => {
    expect(formatCost(0.003)).toBe("<$0.01");
  });

  it("renders normal values with 2dp", () => {
    expect(formatCost(0.054)).toBe("$0.05");
    expect(formatCost(4.218)).toBe("$4.22");
  });
});
