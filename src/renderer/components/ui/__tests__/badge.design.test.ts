import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const badgeSource = readFileSync(resolve(__dirname, "../badge.tsx"), "utf8");

describe("Badge design", () => {
  it("uses explicit transition properties", () => {
    expect(badgeSource).toContain(
      "transition-[color,background-color,border-color,box-shadow]",
    );
    expect(badgeSource).not.toContain("transition-all");
  });
});
