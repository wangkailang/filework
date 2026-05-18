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
export type { DiscoveredSkillView } from "./registry";
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
 * @param enabledSkillIds - Allow-list of personal / additional skill IDs
 *   to register. Skills not in this list are discovered but not
 *   registered (default: empty list). Project skills are always
 *   registered when eligible.
 * @returns The number of external skills registered into the runtime
 */
export async function initSkillDiscovery(
  registry: SkillRegistry,
  workspacePath: string,
  additionalDirs?: string[],
  enabledSkillIds?: Iterable<string>,
): Promise<number> {
  const sources = buildDiscoverySources(workspacePath, additionalDirs);
  const discovered = await discoverSkills(sources);
  registry.registerExternal(discovered, { enabledSkillIds });

  const eligibleCount = discovered.filter((d) => d.eligible).length;
  const registered = registry
    .listAll()
    .filter((s) => s.external !== undefined).length;
  const skipped = eligibleCount - registered;
  console.log(
    `[skills-runtime] Discovered ${discovered.length} external skill(s); ${registered} registered, ${skipped} eligible but not enabled`,
  );

  return registered;
}
