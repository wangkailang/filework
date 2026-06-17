import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync(resolve(__dirname, "../../global.css"), "utf8");

describe("global scrollbar theme", () => {
  it("uses Monokai theme tokens for native scrollbars", () => {
    expect(globalCss).toContain("scrollbar-color:");
    expect(globalCss).toContain("::-webkit-scrollbar-thumb");
    expect(globalCss).toContain("var(--color-scrollbar-thumb)");
    expect(globalCss).toContain("var(--color-scrollbar-track)");
  });
});

describe("global primary theme", () => {
  it("keeps the default primary accent purple in both dark and light themes", () => {
    expect(globalCss).toContain("--color-primary: #a78bfa;");
    expect(globalCss).toContain("--color-primary-bright: #c4b5fd;");
    expect(globalCss).toContain("--color-ring: #a78bfa;");
    expect(globalCss).toContain("--color-primary: #7c3aed;");
    expect(globalCss).toContain("--color-primary-bright: #8b5cf6;");
    expect(globalCss).toContain("--color-ring: #7c3aed;");
  });

  it("keeps inserted skill chips visually subdued", () => {
    const skillMentionRule =
      globalCss.match(/\.prompt-skill-mention \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const lightSkillMentionRule =
      globalCss.match(/\.light \.prompt-skill-mention \{([\s\S]*?)\n\}/)?.[1] ??
      "";

    expect(skillMentionRule).toContain("var(--color-primary)");
    expect(skillMentionRule).toContain("var(--color-muted)");
    expect(skillMentionRule).toContain("var(--color-muted-foreground)");
    expect(skillMentionRule).not.toContain(
      "0 1px 2px color-mix(in oklab, var(--color-primary)",
    );
    expect(lightSkillMentionRule).toContain("var(--color-muted)");
    expect(lightSkillMentionRule).not.toContain("color: var(--color-primary)");
    expect(skillMentionRule).not.toContain("background: var(--color-accent)");
  });

  it("adds a compact generic icon to inserted skill chips", () => {
    const skillMentionIconRule =
      globalCss.match(/\.prompt-skill-mention::before \{([\s\S]*?)\n\}/)?.[1] ??
      "";

    expect(skillMentionIconRule).toContain('content: ""');
    expect(skillMentionIconRule).toContain("currentColor");
  });
});
