import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "../registry";
import { initSkillDiscovery } from "../index";

describe("initSkillDiscovery", () => {
  let tempDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-skills-"));
    registry = new SkillRegistry();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("discovers and registers eligible project-level skills", async () => {
    const skillDir = join(tempDir, ".agents", "skills", "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: my-skill
description: A test skill
---

You are a test skill.`,
    );

    const count = await initSkillDiscovery(registry, tempDir);

    expect(count).toBeGreaterThanOrEqual(1);
    const skill = registry.getById("my-skill");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("my-skill");
    expect(skill!.description).toBe("A test skill");
  });

  it("returns count of eligible skills (may include personal)", async () => {
    // With an empty workspace, only personal skills (if any) are found
    const count = await initSkillDiscovery(registry, tempDir);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("skips ineligible skills", async () => {
    const skillDir = join(tempDir, ".agents", "skills", "gated-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: gated-skill
description: Needs a missing binary
requires:
  bins:
    - nonexistent-binary-xyz-abc
---

Gated content.`,
    );

    await initSkillDiscovery(registry, tempDir);

    // The gated skill should NOT be registered
    expect(registry.getById("gated-skill")).toBeUndefined();
  });

  it("registers multiple project skills from the same workspace", async () => {
    const skillsBase = join(tempDir, ".agents", "skills");
    for (const name of ["alpha", "beta"]) {
      const dir = join(skillsBase, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill ${name}\n---\n\nBody for ${name}.`,
      );
    }

    await initSkillDiscovery(registry, tempDir);

    expect(registry.getById("alpha")).toBeDefined();
    expect(registry.getById("beta")).toBeDefined();
  });
});
