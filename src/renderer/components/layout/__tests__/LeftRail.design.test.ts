import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const leftRailSource = readFileSync(
  resolve(__dirname, "../LeftRail.tsx"),
  "utf8",
);

describe("LeftRail design", () => {
  it("keeps active navigation neutral without glow effects", () => {
    expect(leftRailSource).not.toContain("shadow-[0_0_8px");
    expect(leftRailSource).not.toContain("transition-all");
    expect(leftRailSource).toContain("bg-foreground");
  });
});
