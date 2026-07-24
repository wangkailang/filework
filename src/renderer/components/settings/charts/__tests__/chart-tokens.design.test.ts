import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chartSources = ["CacheEfficiencyChart.tsx", "TokenTimelineChart.tsx"].map(
  (file) => readFileSync(resolve(__dirname, "..", file), "utf8"),
);

describe("settings chart design tokens", () => {
  it("uses theme-aware chart tokens instead of component-local colors", () => {
    for (const source of chartSources) {
      expect(source).not.toMatch(/#[\da-f]{3,8}|rgba\(/i);
      expect(source).toContain("var(--color-chart-");
    }
  });
});
