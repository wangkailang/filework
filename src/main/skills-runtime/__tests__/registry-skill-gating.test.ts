import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSkillDiscovery } from "../index";
import { SkillRegistry } from "../registry";

/**
 * Per-skill gating semantics: personal & additional skills are
 * discovered but only registered into the runtime registry when their
 * id appears in the allow-list. Project skills stay always-on and
 * cannot be toggled.
 */

async function writeSkill(dir: string, id: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${id} body\n---\n\nBody for ${id}.`,
  );
}

describe("SkillRegistry per-skill gating", () => {
  let tempDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "registry-gating-"));
    registry = new SkillRegistry();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers project skills but not additional skills with an empty allow-list", async () => {
    const projectSkillDir = join(tempDir, ".agents", "skills", "proj-skill");
    const additionalRoot = join(tempDir, "extra");
    const additionalSkillDir = join(additionalRoot, "ext-skill");
    await writeSkill(projectSkillDir, "proj-skill");
    await writeSkill(additionalSkillDir, "ext-skill");

    await initSkillDiscovery(registry, tempDir, [additionalRoot]);

    expect(registry.getById("proj-skill")).toBeDefined();
    expect(registry.getById("ext-skill")).toBeUndefined();

    // Both should be visible in the inventory.
    const inventoryIds = registry
      .listAllDiscovered()
      .map((d) => d.skillId)
      .sort();
    expect(inventoryIds).toContain("proj-skill");
    expect(inventoryIds).toContain("ext-skill");

    const ext = registry
      .listAllDiscovered()
      .find((d) => d.skillId === "ext-skill");
    expect(ext?.enabled).toBe(false);
    expect(ext?.eligible).toBe(true);
  });

  it("registers skills present in the allow-list at init time", async () => {
    const additionalRoot = join(tempDir, "extra");
    await writeSkill(join(additionalRoot, "ext-skill"), "ext-skill");

    await initSkillDiscovery(
      registry,
      tempDir,
      [additionalRoot],
      ["ext-skill"],
    );

    expect(registry.getById("ext-skill")).toBeDefined();
    expect(registry.getEnabledSkillIds()).toContain("ext-skill");
  });

  it("setSkillEnabled toggles a single skill at runtime", async () => {
    const additionalRoot = join(tempDir, "extra");
    await writeSkill(join(additionalRoot, "alpha"), "alpha");
    await writeSkill(join(additionalRoot, "beta"), "beta");
    await initSkillDiscovery(registry, tempDir, [additionalRoot]);

    expect(registry.getById("alpha")).toBeUndefined();
    expect(registry.getById("beta")).toBeUndefined();

    registry.setSkillEnabled("alpha", true);
    expect(registry.getById("alpha")).toBeDefined();
    expect(registry.getById("beta")).toBeUndefined();
    expect(registry.getEnabledSkillIds().sort()).toEqual(["alpha"]);

    registry.setSkillEnabled("alpha", false);
    expect(registry.getById("alpha")).toBeUndefined();
    expect(registry.getEnabledSkillIds()).toEqual([]);

    // The skills stay in the discovered inventory throughout.
    const ids = registry.listAllDiscovered().map((d) => d.skillId);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("setSkillEnabled is a no-op for project skills", async () => {
    const projectSkillDir = join(tempDir, ".agents", "skills", "proj-skill");
    await writeSkill(projectSkillDir, "proj-skill");
    await initSkillDiscovery(registry, tempDir);

    expect(registry.getById("proj-skill")).toBeDefined();
    expect(registry.getEnabledSkillIds()).toEqual([]);

    registry.setSkillEnabled("proj-skill", false);
    // Project skills are not in the allow-list pathway; still registered.
    expect(registry.getById("proj-skill")).toBeDefined();
    expect(registry.getEnabledSkillIds()).toEqual([]);
  });
});
