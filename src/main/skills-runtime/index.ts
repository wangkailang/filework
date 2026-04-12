/**
 * AI Skills Runtime — entry point
 *
 * Discovers, parses, registers, and executes SKILL.md-based skills
 * alongside the existing built-in skill system.
 */

import { buildDiscoverySources, discoverSkills } from "./discovery";
import type { SkillRegistry } from "./registry";

export {
  buildDiscoverySources,
  checkEligibility,
  discoverSkills,
} from "./discovery";
export type { ExecutionContext, ExecutorDeps } from "./executor";
export {
  buildSkillCatalogXml,
  determineInjectionMode,
  ensurePipDeps,
  executeSkill,
  executeSubagent,
  wrapWithSecurityBoundary,
} from "./executor";
export { runHook } from "./hooks";
export { parseSkillMd, printSkillMd } from "./parser";
export { preprocessSkill } from "./preprocessor";
export { SkillRegistry } from "./registry";
export {
  BLOCKED_COMMAND_PREFIXES,
  buildSafeEnv,
  computeSkillHash,
  getTrustLevel,
  isCommandAllowed,
  isSkillTrusted,
  requestSkillApproval,
  SAFE_COMMAND_PREFIXES,
} from "./security";

/**
 * Initialize skill discovery and register external skills.
 *
 * Scans personal, project, and optional additional directories for
 * SKILL.md files, runs eligibility checks, and registers eligible
 * skills into the provided {@link SkillRegistry}.
 *
 * @param registry - The singleton SkillRegistry instance
 * @param workspacePath - Absolute path to the current workspace root
 * @param additionalDirs - Optional extra directories to scan
 * @returns The number of external skills registered
 */
export async function initSkillDiscovery(
  registry: SkillRegistry,
  workspacePath: string,
  additionalDirs?: string[],
): Promise<number> {
  const sources = buildDiscoverySources(workspacePath, additionalDirs);
  const discovered = await discoverSkills(sources);
  registry.registerExternal(discovered);

  const eligible = discovered.filter((d) => d.eligible).length;
  console.log(
    `[skills-runtime] Discovered ${discovered.length} external skill(s), ${eligible} eligible and registered`,
  );

  return eligible;
}
