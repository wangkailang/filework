import type { Skill } from "./types";
import { fileOrganizer } from "./file-organizer";
import { reportGenerator } from "./report-generator";
import { dataProcessor } from "./data-processor";
import { contentSearch } from "./content-search";
import { duplicateFinder } from "./duplicate-finder";
import { projectScaffolder } from "./project-scaffolder";
import { pdfProcessor } from "./pdf-processor";
import { xlsxProcessor } from "./xlsx-processor";
import { docxProcessor } from "./docx-processor";
import { SkillRegistry } from "../skills-runtime";

export type { Skill } from "./types";

/** All built-in skills */
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
];

/** Singleton SkillRegistry instance with built-in skills pre-registered */
export const skillRegistry = new SkillRegistry();
skillRegistry.registerBuiltIn(skills);

/** Get a skill by id (delegates to SkillRegistry) */
export const getSkill = (id: string): Skill | undefined =>
  skillRegistry.getById(id);

/**
 * Match the best skill for a user prompt (delegates to SkillRegistry).
 *
 * Uses the unified scoring algorithm that works across both built-in
 * and external skills.
 */
export const matchSkill = (prompt: string): Skill | undefined =>
  skillRegistry.matchByPrompt(prompt);

/** Get all skill suggestions (for onboarding) */
export const getAllSuggestions = (): Array<{ skillId: string; text: string }> =>
  skillRegistry
    .listAll()
    .flatMap((s) =>
      (s.suggestions ?? []).map((text) => ({ skillId: s.id, text })),
    );
