import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../plan-viewer.tsx"), "utf8");

describe("PlanViewer design", () => {
  it("uses shared status tokens instead of palette-specific utility colors", () => {
    expect(source).toContain("text-status-success");
    expect(source).toContain("text-status-running");
    expect(source).toContain("text-status-await");
    expect(source).toContain("text-status-error");
    expect(source).not.toMatch(
      /(?:text|bg)-(?:green|blue|red|amber|emerald|yellow)-/,
    );
  });

  it("keeps persistent plan text at the shared 12px minimum", () => {
    expect(source).not.toMatch(/text-\[(?:10|10\.5|11)px\]/);
  });
});
