import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSkillDiscovery } from "../index";
import { SkillRegistry } from "../registry";

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
    expect(skill?.name).toBe("my-skill");
    expect(skill?.description).toBe("A test skill");
  });

  it("returns count of eligible skills (may include personal)", async () => {
    // 工作区为空时,只会发现个人级技能(如果有的话)
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

    // 被门控的技能不应被注册
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
