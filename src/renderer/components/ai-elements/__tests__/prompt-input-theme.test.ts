import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const promptInputSource = readFileSync(
  resolve(__dirname, "../prompt-input.tsx"),
  "utf8",
);

describe("PromptInput skill command theme", () => {
  it("uses restrained primary accents for the selected slash skill row", () => {
    expect(promptInputSource).toContain("bg-primary/10");
    expect(promptInputSource).toContain("var(--color-primary)");
    expect(promptInputSource).toContain("ring-primary/20");
    expect(promptInputSource).not.toContain("bg-accent text-accent-foreground");
    expect(promptInputSource).not.toContain("transition-all");
  });

  it("keeps inserted skill chips compact and exposes metadata on hover", () => {
    expect(promptInputSource).toContain('description: { default: "" }');
    expect(promptInputSource).toContain(
      '"data-skill-description": description',
    );
    expect(promptInputSource).toContain('"data-skill-source": source');
    expect(promptInputSource).toContain("title,");
    expect(promptInputSource).toContain("prompt-skill-mention__name");
    expect(promptInputSource).not.toContain(
      "prompt-skill-mention__description",
    );
    expect(promptInputSource).not.toContain("prompt-skill-mention__source");
  });
});
