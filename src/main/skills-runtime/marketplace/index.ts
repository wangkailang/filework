/**
 * 市场编排层。
 *
 * list:拉 registry + 标记本地已装状态。
 * install:安装文件 + 计算内容哈希,把哈希随结果返回(不写信任 / 不碰 db)。
 * uninstall:删目录(不碰 db)。
 * 信任写库、重扫、启用由 Electron 侧 ai-handlers 负责。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { computeSkillHash } from "../security";
import { DEFAULT_SKILLS_ROOT, installEntry, uninstallSkill } from "./installer";
import { fetchRegistry as defaultFetchRegistry } from "./registry-client";
import type {
  InstallResult,
  MarketEntry,
  MarketEntryWithStatus,
} from "./types";

interface ListOpts {
  skillsRoot?: string;
  fetchRegistry?: () => Promise<MarketEntry[]>;
}

/** 拉取市场清单并标注本地安装状态。 */
export async function listMarket(
  opts: ListOpts = {},
): Promise<MarketEntryWithStatus[]> {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  const fetchReg = opts.fetchRegistry ?? (() => defaultFetchRegistry());
  const entries = await fetchReg();
  return entries.map((e) => ({
    ...e,
    // 以 SKILL.md 存在性为判断依据
    installed: existsSync(join(skillsRoot, e.id, "SKILL.md")),
  }));
}

interface MutateOpts {
  skillsRoot?: string;
}

/**
 * 安装一条市场条目,成功后计算内容哈希并随结果返回。
 * 不写信任、不触发重扫 —— 由调用方(Electron ai-handlers)完成。
 */
export async function installMarketSkill(
  entry: MarketEntry,
  opts: MutateOpts = {},
): Promise<InstallResult> {
  const skillsRoot = opts.skillsRoot ?? DEFAULT_SKILLS_ROOT;
  const res = await installEntry(entry, { skillsRoot });
  if (!res.ok || !res.installedPath) return res;

  let contentHash = "";
  try {
    contentHash = await computeSkillHash(join(skillsRoot, entry.id));
  } catch {
    // 哈希计算失败不影响安装结果,以空串兜底
    contentHash = "";
  }
  return { ...res, contentHash };
}

/** 卸载一条市场 skill(只删目录,信任记录由调用方删)。 */
export async function uninstallMarketSkill(
  skillId: string,
  opts: MutateOpts = {},
): Promise<void> {
  await uninstallSkill(skillId, { skillsRoot: opts.skillsRoot });
}
