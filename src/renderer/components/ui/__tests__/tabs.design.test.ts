import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tabsSource = fs.readFileSync(path.join(__dirname, "../tabs.tsx"), "utf8");

describe("Tabs design treatment", () => {
  it("uses explicit transitions instead of transition-all", () => {
    expect(tabsSource).toContain(
      "transition-[color,background-color,border-color,box-shadow]",
    );
    expect(tabsSource).not.toContain("transition-all");
  });
});
