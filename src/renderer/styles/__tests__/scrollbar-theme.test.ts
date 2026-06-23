import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync(resolve(__dirname, "../../global.css"), "utf8");

describe("global scrollbar theme", () => {
  it("uses neutral theme tokens for native scrollbars", () => {
    expect(globalCss).toContain("scrollbar-color:");
    expect(globalCss).toContain("::-webkit-scrollbar-thumb");
    expect(globalCss).toContain("var(--color-scrollbar-thumb)");
    expect(globalCss).toContain("var(--color-scrollbar-track)");
  });
});

describe("global primary theme", () => {
  it("uses a neutral Geist-like palette with blue as the only primary accent", () => {
    expect(globalCss).toContain("Neutral Agent Console");
    expect(globalCss).toContain("--color-background: #0a0a0a;");
    expect(globalCss).toContain("--color-foreground: #ededed;");
    expect(globalCss).toContain("--color-surface: #111111;");
    expect(globalCss).toContain("--color-card: #171717;");
    expect(globalCss).toContain("--color-primary: #006efe;");
    expect(globalCss).toContain("--color-primary-bright: #47a8ff;");
    expect(globalCss).toContain("--color-ring: #47a8ff;");
    expect(globalCss).toContain("--color-primary: #006bff;");
    expect(globalCss).toContain("--color-primary-bright: #0059ec;");
    expect(globalCss).not.toContain("#a78bfa");
    expect(globalCss).not.toContain("#f92672");
    expect(globalCss).not.toContain("#a6e22e");
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
