/**
 * AI Skills Runtime 的发现模块。
 *
 * 扫描多个目录中的 SKILL.md 文件并解析,
 * 检查可用性(bins、env、os),返回已发现的技能,
 * 并按优先级去重(project > personal)。
 */

import { execSync } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import fg from "fast-glob";
import which from "which";

import { parseSkillMd } from "./parser";
import type { DiscoveredSkill, DiscoverySource, ParsedSkill } from "./types";

/**
 * 构建默认的发现来源列表。
 *
 * 顺序决定优先级:先 personal,再 project。
 * 当两者包含相同 ID 的技能时,以项目级技能为准
 *(在 {@link discoverSkills} 的去重过程中生效)。
 *
 * @param workspacePath - 当前工作区根目录的绝对路径
 * @param additionalDirs - 可选的额外扫描目录
 */
export function buildDiscoverySources(
  workspacePath: string,
  additionalDirs?: string[],
): DiscoverySource[] {
  const sources: DiscoverySource[] = [
    { type: "personal", basePath: join(homedir(), ".agents", "skills") },
    { type: "project", basePath: join(workspacePath, ".agents", "skills") },
  ];

  if (additionalDirs) {
    for (const dir of additionalDirs) {
      sources.push({ type: "additional", basePath: dir });
    }
  }

  return sources;
}

/**
 * 检查目录是否存在且可访问。
 * 可访问时返回 `true`,否则(静默地)返回 `false`。
 */
async function isAccessible(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从已解析的技能中推导出技能 ID。
 *
 * 存在 `frontmatter.name` 时使用它,否则回退到
 * SKILL.md 文件所在父目录的名称。
 */
function deriveSkillId(parsed: ParsedSkill): string {
  if (parsed.frontmatter.name) {
    return parsed.frontmatter.name;
  }
  // sourcePath 是 SKILL.md 的绝对路径 —— 取其父目录名
  return basename(join(parsed.sourcePath, ".."));
}

/**
 * 检查技能是否满足其声明的运行时依赖。
 *
 * 检查项(按顺序):
 * 1. `requires.os`  — 当前平台必须在列表中
 * 2. `requires.bins` — 每个二进制都必须能在 PATH 中找到(通过 `which`)
 * 3. `requires.env`  — 每个环境变量都必须在 `process.env` 中设置
 *
 * 全部检查通过时返回 `{ eligible: true }`,
 * 否则在首个失败处返回 `{ eligible: false, reason }`。
 */
export function checkEligibility(skill: ParsedSkill): {
  eligible: boolean;
  reason?: string;
} {
  const requires = skill.frontmatter.requires;
  if (!requires) {
    return { eligible: true };
  }

  // OS 检查(同步)
  if (requires.os && requires.os.length > 0) {
    if (!requires.os.includes(process.platform)) {
      return {
        eligible: false,
        reason: `OS mismatch: requires [${requires.os.join(", ")}], current is ${process.platform}`,
      };
    }
  }

  // Env 检查(同步)
  if (requires.env && requires.env.length > 0) {
    for (const envVar of requires.env) {
      if (!(envVar in process.env) || process.env[envVar] === undefined) {
        return {
          eligible: false,
          reason: `Missing environment variable: ${envVar}`,
        };
      }
    }
  }

  // Bins 检查 —— 使用 which.sync 做同步检查
  if (requires.bins && requires.bins.length > 0) {
    for (const bin of requires.bins) {
      try {
        which.sync(bin);
      } catch {
        return {
          eligible: false,
          reason: `Required binary not found in PATH: ${bin}`,
        };
      }
    }
  }

  // Pip 检查 —— 验证 Python 模块是否可导入
  if (requires.pip && requires.pip.length > 0) {
    let pythonBin = "python3";
    try {
      pythonBin = which.sync("python3");
    } catch {
      return {
        eligible: false,
        reason:
          "Required binary not found in PATH: python3 (needed for pip dependencies)",
      };
    }

    for (const pkg of requires.pip) {
      // 提取模块名(剥离 extras,如 "markitdown[pptx,pdf]" → "markitdown")
      const moduleName = pkg.replace(/\[.*\]$/, "").trim();
      try {
        execSync(`"${pythonBin}" -c "import ${moduleName}"`, {
          timeout: 10_000,
          stdio: "pipe",
        });
      } catch {
        // 模块不可导入 —— 仍视为可用,但会在执行时自动安装
        console.debug(
          `[skills-discovery] Skill pip dependency "${moduleName}" not found, will auto-install at execution time`,
        );
      }
    }
  }

  return { eligible: true };
}

/** 各来源类型的优先级权重 —— 去重时数值越大优先级越高 */
const SOURCE_PRIORITY: Record<DiscoverySource["type"], number> = {
  personal: 1,
  additional: 2,
  project: 3,
};

/**
 * 扫描给定的发现来源中的 SKILL.md 文件并解析,
 * 执行可用性检查,返回去重后的列表。
 *
 * 当多个来源包含相同 ID 的技能时,以优先级更高的来源为准
 *(project > additional > personal)。
 *
 * 不存在或不可访问的目录会被静默跳过。
 * 单个 SKILL.md 解析失败会被记录并跳过。
 */
export async function discoverSkills(
  sources: DiscoverySource[],
): Promise<DiscoveredSkill[]> {
  /** skillId → 最优 DiscoveredSkill 的映射(优先级最高者胜出) */
  const skillMap = new Map<string, DiscoveredSkill>();

  for (const source of sources) {
    if (!(await isAccessible(source.basePath))) {
      console.debug(
        `[skills-discovery] Skipping inaccessible source: ${source.basePath}`,
      );
      continue;
    }

    // 扫描该来源下的所有 SKILL.md 文件
    let skillPaths: string[];
    try {
      skillPaths = await fg("**/SKILL.md", {
        cwd: source.basePath,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: false,
      });
    } catch (err) {
      console.warn(
        `[skills-discovery] Error scanning ${source.basePath}:`,
        err,
      );
      continue;
    }

    for (const skillPath of skillPaths) {
      let content: string;
      try {
        const { readFile } = await import("node:fs/promises");
        content = await readFile(skillPath, "utf-8");
      } catch (err) {
        console.warn(`[skills-discovery] Failed to read ${skillPath}:`, err);
        continue;
      }

      let parsed: ParsedSkill;
      try {
        parsed = parseSkillMd(content, skillPath);
      } catch (err) {
        console.warn(`[skills-discovery] Failed to parse ${skillPath}:`, err);
        continue;
      }

      const skillId = deriveSkillId(parsed);
      const eligibility = checkEligibility(parsed);

      if (!eligibility.eligible) {
        console.debug(
          `[skills-discovery] Skill "${skillId}" ineligible: ${eligibility.reason}`,
        );
      }

      const discovered: DiscoveredSkill = {
        parsed,
        source,
        skillId,
        eligible: eligibility.eligible,
        ineligibleReason: eligibility.reason,
      };

      // 去重:优先级更高的来源胜出
      const existing = skillMap.get(skillId);
      if (
        !existing ||
        SOURCE_PRIORITY[source.type] > SOURCE_PRIORITY[existing.source.type]
      ) {
        skillMap.set(skillId, discovered);
      }
    }
  }

  return Array.from(skillMap.values());
}
