/**
 * AI 技能运行时 —— 入口
 *
 * 在现有内置技能系统之外,发现、解析、注册并执行基于 SKILL.md 的技能。
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
  hydrateTrust,
  isCommandAllowed,
  isSkillTrusted,
  recordTrust,
  requestSkillApproval,
  SAFE_COMMAND_PREFIXES,
} from "./security";
export type { SkillTrustRecord } from "./types";

export {
  installMarketSkill,
  listMarket,
  uninstallMarketSkill,
} from "./marketplace";
export type {
  InstallResult,
  MarketEntry,
  MarketEntryWithStatus,
} from "./marketplace/types";

/**
 * 初始化技能发现并注册外部技能。
 *
 * 扫描个人、项目以及可选的附加目录中的 SKILL.md 文件,
 * 运行资格检查,并将符合条件的技能注册到提供的
 * {@link SkillRegistry} 中。
 *
 * @param registry - 单例 SkillRegistry 实例
 * @param workspacePath - 当前工作区根目录的绝对路径
 * @param additionalDirs - 可选的额外扫描目录
 * @param enabledSkillIds - 允许注册的个人 / 附加技能 ID 白名单。
 *   不在此列表中的技能会被发现但不被注册(默认:空列表)。
 *   项目技能在符合条件时始终被注册。
 * @returns 注册到运行时的外部技能数量
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
