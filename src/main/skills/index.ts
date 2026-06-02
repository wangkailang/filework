import { SkillRegistry } from "../skills-runtime";
import { contentSearch } from "./content-search";
import { dataProcessor } from "./data-processor";
import { docxProcessor } from "./docx-processor";
import { duplicateFinder } from "./duplicate-finder";
import { fileOrganizer } from "./file-organizer";
import { pdfProcessor } from "./pdf-processor";
import { pptxProcessor } from "./pptx-processor";
import { projectScaffolder } from "./project-scaffolder";
import { reportGenerator } from "./report-generator";
import type { Skill } from "./types";
import { xlsxProcessor } from "./xlsx-processor";

export type { Skill } from "./types";

/** 所有内置 skill */
export const skills: Skill[] = [
  fileOrganizer,
  reportGenerator,
  dataProcessor,
  contentSearch,
  duplicateFinder,
  projectScaffolder,
  pdfProcessor,
  xlsxProcessor,
  docxProcessor,
  pptxProcessor,
];

/** 预注册了内置 skill 的 SkillRegistry 单例 */
export const skillRegistry = new SkillRegistry();
skillRegistry.registerBuiltIn(skills);

/** 按 id 获取 skill(委托给 SkillRegistry) */
export const getSkill = (id: string): Skill | undefined =>
  skillRegistry.getById(id);

/**
 * 为用户 prompt 匹配最合适的 skill(委托给 SkillRegistry)。
 *
 * 使用统一的评分算法,同时适用于内置和外部 skill。
 */
export const matchSkill = (prompt: string): Skill | undefined =>
  skillRegistry.matchByPrompt(prompt);

/** 获取所有 skill 建议(用于引导) */
export const getAllSuggestions = (): Array<{ skillId: string; text: string }> =>
  skillRegistry
    .listAll()
    .flatMap((s) =>
      (s.suggestions ?? []).map((text) => ({ skillId: s.id, text })),
    );
