import { describe, expect, it } from "vitest";

import { parseSkillMd, printSkillMd } from "../parser";
import { SkillParseError, SkillValidationError } from "../types";

describe("parseSkillMd", () => {
  it("parses a valid SKILL.md with frontmatter and body", () => {
    const content = `---
name: code-reviewer
description: Reviews code
model: claude-sonnet-4-20250514
context: fork
allowed-tools:
  - readFile
  - listDirectory
disable-model-invocation: false
user-invocable: true
requires:
  bins:
    - eslint
  env:
    - ANTHROPIC_API_KEY
  os:
    - darwin
    - linux
hooks:
  pre-activate: ./scripts/setup.sh
  post-complete: ./scripts/cleanup.sh
---
You are a code review expert.
`;
    const result = parseSkillMd(content, "/path/to/SKILL.md");

    expect(result.frontmatter.name).toBe("code-reviewer");
    expect(result.frontmatter.description).toBe("Reviews code");
    expect(result.frontmatter.model).toBe("claude-sonnet-4-20250514");
    expect(result.frontmatter.context).toBe("fork");
    expect(result.frontmatter["allowed-tools"]).toEqual(["readFile", "listDirectory"]);
    expect(result.frontmatter["disable-model-invocation"]).toBe(false);
    expect(result.frontmatter["user-invocable"]).toBe(true);
    expect(result.frontmatter.requires?.bins).toEqual(["eslint"]);
    expect(result.frontmatter.requires?.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.frontmatter.requires?.os).toEqual(["darwin", "linux"]);
    expect(result.frontmatter.hooks?.["pre-activate"]).toBe("./scripts/setup.sh");
    expect(result.frontmatter.hooks?.["post-complete"]).toBe("./scripts/cleanup.sh");
    expect(result.body).toContain("You are a code review expert.");
    expect(result.sourcePath).toBe("/path/to/SKILL.md");
  });

  it("treats entire content as body when no frontmatter is present", () => {
    const content = "# Just a markdown file\n\nSome content here.";
    const result = parseSkillMd(content, "/path/to/SKILL.md");

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
    expect(result.sourcePath).toBe("/path/to/SKILL.md");
  });

  it("throws SkillParseError for empty content", () => {
    expect(() => parseSkillMd("", "/path/to/SKILL.md")).toThrow(SkillParseError);
    expect(() => parseSkillMd("   ", "/path/to/SKILL.md")).toThrow(SkillParseError);
    expect(() => parseSkillMd("\n\n", "/path/to/SKILL.md")).toThrow(SkillParseError);
  });

  it("throws SkillValidationError for invalid name (not kebab-case)", () => {
    const content = `---\nname: NotKebab\n---\nBody`;
    expect(() => parseSkillMd(content, "/path/to/SKILL.md")).toThrow(SkillValidationError);
  });

  it("throws SkillValidationError for name exceeding 64 characters", () => {
    const longName = "a" + "-b".repeat(32); // 65 chars
    const content = `---\nname: ${longName}\n---\nBody`;
    expect(() => parseSkillMd(content, "/path/to/SKILL.md")).toThrow(SkillValidationError);
  });

  it("accepts a valid kebab-case name at exactly 64 characters", () => {
    // Build a 64-char kebab-case name: "a-b" repeated to fill
    const name = "a-bb".repeat(16); // 64 chars: "a-bba-bba-bb..."
    // Actually let's be precise
    const segments = [];
    let len = 0;
    while (len < 60) {
      segments.push("abcd");
      len += 5; // "abcd" + "-"
    }
    const kebabName = segments.join("-").slice(0, 64);
    // Ensure it's valid kebab-case and exactly 64 chars
    const validName = "a".repeat(64); // simple: all lowercase, no hyphens, valid kebab
    expect(validName.length).toBe(64);
    const content = `---\nname: ${validName}\n---\nBody`;
    const result = parseSkillMd(content, "/path/to/SKILL.md");
    expect(result.frontmatter.name).toBe(validName);
  });

  it("ignores unrecognized frontmatter fields", () => {
    const content = `---
name: my-skill
unknown-field: some-value
another-unknown: 42
---
Body content`;
    const result = parseSkillMd(content, "/path/to/SKILL.md");

    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter).not.toHaveProperty("unknown-field");
    expect(result.frontmatter).not.toHaveProperty("another-unknown");
    expect(result.body).toContain("Body content");
  });

  it("handles frontmatter with only unknown fields as having frontmatter", () => {
    const content = `---
unknown: value
---
Body`;
    const result = parseSkillMd(content, "/path/to/SKILL.md");
    // Unknown fields are stripped, so frontmatter should be empty
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("Body");
  });
});

describe("printSkillMd", () => {
  it("outputs just the body when frontmatter is empty", () => {
    const result = printSkillMd({
      frontmatter: {},
      body: "# Hello\n\nWorld",
      sourcePath: "/path/to/SKILL.md",
    });
    expect(result).toBe("# Hello\n\nWorld");
  });

  it("outputs YAML frontmatter block when frontmatter has fields", () => {
    const result = printSkillMd({
      frontmatter: { name: "my-skill", description: "A skill" },
      body: "Body content\n",
      sourcePath: "/path/to/SKILL.md",
    });
    expect(result).toContain("---");
    expect(result).toContain("name: my-skill");
    expect(result).toContain("description: A skill");
    expect(result).toContain("Body content");
  });

  it("roundtrips: parseSkillMd(printSkillMd(skill)) produces equivalent result", () => {
    const original = {
      frontmatter: {
        name: "test-skill",
        description: "A test skill",
        context: "fork" as const,
        "allowed-tools": ["readFile"],
      },
      body: "\nYou are a helpful assistant.\n",
      sourcePath: "/path/to/SKILL.md",
    };

    const printed = printSkillMd(original);
    const reparsed = parseSkillMd(printed, original.sourcePath);

    expect(reparsed.frontmatter).toEqual(original.frontmatter);
    expect(reparsed.body.trim()).toBe(original.body.trim());
    expect(reparsed.sourcePath).toBe(original.sourcePath);
  });
});
