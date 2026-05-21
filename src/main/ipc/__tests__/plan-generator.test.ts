import { describe, expect, it } from "vitest";
import { skills } from "../../skills";
import { buildRelevantSkillCatalog } from "../plan-generator";

describe("buildRelevantSkillCatalog", () => {
  const totalCount = skills.length;
  const taskSkillCount = skills.filter((s) => s.category === "task").length;

  it("always includes every task-category skill regardless of prompt", () => {
    const catalog = buildRelevantSkillCatalog("totally unrelated prompt");
    for (const s of skills.filter((sk) => sk.category === "task")) {
      expect(catalog).toContain(s.id);
    }
  });

  it("includes a tool-category skill when the prompt hits one of its keywords", () => {
    const pdfSkill = skills.find((s) => s.id === "pdf-processor");
    expect(pdfSkill).toBeDefined();
    if (!pdfSkill) return;
    const keyword = pdfSkill.keywords[0];
    const catalog = buildRelevantSkillCatalog(`please process this ${keyword}`);
    expect(catalog).toContain("pdf-processor");
  });

  it("matching is case-insensitive", () => {
    const pdfSkill = skills.find((s) => s.id === "pdf-processor");
    expect(pdfSkill).toBeDefined();
    if (!pdfSkill) return;
    const keyword = pdfSkill.keywords[0];
    const catalog = buildRelevantSkillCatalog(
      `PROCESS THIS ${keyword.toUpperCase()}`,
    );
    expect(catalog).toContain("pdf-processor");
  });

  it("falls back to the full catalog when fewer than 3 skills match", () => {
    // An obviously empty prompt should match only task-category skills.
    const empty = buildRelevantSkillCatalog("xyzzy");
    const lineCount = empty.split("\n").length;
    if (taskSkillCount >= 3) {
      // Filtered path: only task skills surface.
      expect(lineCount).toBe(taskSkillCount);
    } else {
      // Fallback path: full catalog returned.
      expect(lineCount).toBe(totalCount);
    }
  });

  it("output uses the markdown bullet format expected by the planner prompt", () => {
    const catalog = buildRelevantSkillCatalog("");
    for (const line of catalog.split("\n")) {
      expect(line).toMatch(/^- \*\*[^*]+\*\*: .+ — /);
    }
  });
});
