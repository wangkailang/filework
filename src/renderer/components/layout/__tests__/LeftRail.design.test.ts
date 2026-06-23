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

  it("aligns the collapsed expand button with the telemetry row", () => {
    expect(leftRailSource).toContain("absolute left-2 top-0");
    expect(leftRailSource).toContain(
      "h-[34px] w-12 items-center justify-center",
    );
  });
});
