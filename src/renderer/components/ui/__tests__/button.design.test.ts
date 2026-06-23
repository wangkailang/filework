import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const buttonSource = readFileSync(resolve(__dirname, "../button.tsx"), "utf8");

describe("Button design", () => {
  it("uses explicit transition properties", () => {
    expect(buttonSource).toContain(
      "transition-[color,background-color,border-color,box-shadow,transform]",
    );
    expect(buttonSource).not.toContain("transition-all");
  });
});
