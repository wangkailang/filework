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
    // 明显无意义的 prompt 应该只匹配到 task 类别的 skill。
    const empty = buildRelevantSkillCatalog("xyzzy");
    const lineCount = empty.split("\n").length;
    if (taskSkillCount >= 3) {
      // 过滤路径:只有 task skill 浮现。
      expect(lineCount).toBe(taskSkillCount);
    } else {
      // 回落路径:返回完整目录。
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
