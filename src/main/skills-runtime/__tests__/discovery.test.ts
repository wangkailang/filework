import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDiscoverySources,
  checkEligibility,
  discoverSkills,
} from "../discovery";
import type { ParsedSkill } from "../types";

// ─── buildDiscoverySources ───────────────────────────────────────────

describe("buildDiscoverySources", () => {
  it("returns personal and project sources by default", () => {
    const sources = buildDiscoverySources("/my/workspace");

    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      type: "personal",
      basePath: join(homedir(), ".agents", "skills"),
    });
    expect(sources[1]).toEqual({
      type: "project",
      basePath: join("/my/workspace", ".agents", "skills"),
    });
  });

  it("appends additional directories when provided", () => {
    const sources = buildDiscoverySources("/ws", ["/extra/a", "/extra/b"]);

    expect(sources).toHaveLength(4);
    expect(sources[2]).toEqual({ type: "additional", basePath: "/extra/a" });
    expect(sources[3]).toEqual({ type: "additional", basePath: "/extra/b" });
  });

  it("returns only personal and project when additionalDirs is empty", () => {
    const sources = buildDiscoverySources("/ws", []);
    expect(sources).toHaveLength(2);
  });
});

// ─── checkEligibility ────────────────────────────────────────────────

describe("checkEligibility", () => {
  const makeSkill = (
    requires?: ParsedSkill["frontmatter"]["requires"],
  ): ParsedSkill => ({
    frontmatter: { name: "test-skill", ...(requires ? { requires } : {}) },
    body: "body",
    sourcePath: "/path/to/SKILL.md",
  });

  it("returns eligible when no requires field is present", () => {
    const result = checkEligibility(makeSkill());
    expect(result).toEqual({ eligible: true });
  });

  it("returns eligible when requires is empty", () => {
    const result = checkEligibility(makeSkill({}));
    expect(result).toEqual({ eligible: true });
  });

  it("returns eligible when current OS matches requires.os", () => {
    const result = checkEligibility(makeSkill({ os: [process.platform] }));
    expect(result).toEqual({ eligible: true });
  });

  it("returns ineligible when current OS does not match requires.os", () => {
    const result = checkEligibility(makeSkill({ os: ["fake-os-xyz"] }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("OS mismatch");
  });

  it("returns eligible when required env vars are set", () => {
    // PATH is always set
    const result = checkEligibility(makeSkill({ env: ["PATH"] }));
    expect(result).toEqual({ eligible: true });
  });

  it("returns ineligible when required env var is missing", () => {
    const result = checkEligibility(
      makeSkill({ env: ["TOTALLY_NONEXISTENT_VAR_XYZ_123"] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("Missing environment variable");
  });

  it("returns eligible when required binary exists in PATH", () => {
    // 'node' should always be available in test environment
    const result = checkEligibility(makeSkill({ bins: ["node"] }));
    expect(result).toEqual({ eligible: true });
  });

  it("returns ineligible when required binary is not in PATH", () => {
    const result = checkEligibility(
      makeSkill({ bins: ["nonexistent-binary-xyz-999"] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("Required binary not found");
  });

  it("fails on first missing binary even if others exist", () => {
    const result = checkEligibility(
      makeSkill({ bins: ["nonexistent-binary-xyz-999", "node"] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("nonexistent-binary-xyz-999");
  });
});

// ─── discoverSkills ──────────────────────────────────────────────────

describe("discoverSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "skills-discovery-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a SKILL.md in a subdirectory */
  async function createSkill(
    base: string,
    dirName: string,
    content: string,
  ): Promise<void> {
    const skillDir = join(base, dirName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), content, "utf-8");
  }

  it("discovers skills from a single source", async () => {
    const sourceDir = join(tmpDir, "personal");
    await createSkill(sourceDir, "my-skill", "---\nname: my-skill\n---\nHello");

    const results = await discoverSkills([
      { type: "personal", basePath: sourceDir },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("my-skill");
    expect(results[0].source.type).toBe("personal");
    expect(results[0].eligible).toBe(true);
  });

  it("discovers skills from nested directories", async () => {
    const sourceDir = join(tmpDir, "nested");
    await createSkill(
      sourceDir,
      "a/b/deep-skill",
      "---\nname: deep-skill\n---\nDeep",
    );

    const results = await discoverSkills([
      { type: "project", basePath: sourceDir },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("deep-skill");
  });

  it("silently skips non-existent directories", async () => {
    const results = await discoverSkills([
      { type: "personal", basePath: join(tmpDir, "does-not-exist") },
    ]);

    expect(results).toHaveLength(0);
  });

  it("project-level skill overrides personal-level skill with same ID", async () => {
    const personalDir = join(tmpDir, "personal");
    const projectDir = join(tmpDir, "project");

    await createSkill(
      personalDir,
      "shared",
      "---\nname: shared\n---\nPersonal version",
    );
    await createSkill(
      projectDir,
      "shared",
      "---\nname: shared\n---\nProject version",
    );

    const results = await discoverSkills([
      { type: "personal", basePath: personalDir },
      { type: "project", basePath: projectDir },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("shared");
    expect(results[0].source.type).toBe("project");
    expect(results[0].parsed.body).toContain("Project version");
  });

  it("uses directory name as skill ID when frontmatter.name is absent", async () => {
    const sourceDir = join(tmpDir, "source");
    await createSkill(sourceDir, "dir-based-id", "Just a body, no frontmatter");

    const results = await discoverSkills([
      { type: "personal", basePath: sourceDir },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("dir-based-id");
  });

  it("marks ineligible skills with eligible: false", async () => {
    const sourceDir = join(tmpDir, "source");
    await createSkill(
      sourceDir,
      "gated",
      "---\nname: gated\nrequires:\n  bins:\n    - nonexistent-binary-xyz\n---\nBody",
    );

    const results = await discoverSkills([
      { type: "project", basePath: sourceDir },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].eligible).toBe(false);
    expect(results[0].ineligibleReason).toContain("nonexistent-binary-xyz");
  });

  it("skips unparseable SKILL.md files and continues", async () => {
    const sourceDir = join(tmpDir, "source");
    // Valid skill
    await createSkill(sourceDir, "good", "---\nname: good\n---\nGood skill");
    // Empty file (will throw SkillParseError)
    await createSkill(sourceDir, "bad", "");

    const results = await discoverSkills([
      { type: "project", basePath: sourceDir },
    ]);

    // Only the valid skill should be discovered
    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("good");
  });

  it("discovers multiple skills from multiple sources", async () => {
    const personalDir = join(tmpDir, "personal");
    const projectDir = join(tmpDir, "project");

    await createSkill(personalDir, "skill-a", "---\nname: skill-a\n---\nA");
    await createSkill(projectDir, "skill-b", "---\nname: skill-b\n---\nB");

    const results = await discoverSkills([
      { type: "personal", basePath: personalDir },
      { type: "project", basePath: projectDir },
    ]);

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.skillId).sort();
    expect(ids).toEqual(["skill-a", "skill-b"]);
  });
});
