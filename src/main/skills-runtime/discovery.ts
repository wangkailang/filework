/**
 * Discovery module for AI Skills Runtime.
 *
 * Scans multiple directories for SKILL.md files, parses them,
 * checks eligibility (bins, env, os), and returns discovered skills
 * with priority-based deduplication (project > personal).
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
 * Build the default list of discovery sources.
 *
 * Order matters for priority: personal first, then project.
 * When both contain a skill with the same ID, the project-level
 * skill wins (applied during deduplication in {@link discoverSkills}).
 *
 * @param workspacePath - Absolute path to the current workspace root
 * @param additionalDirs - Optional extra directories to scan
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
 * Check whether a directory exists and is accessible.
 * Returns `true` when accessible, `false` otherwise (silently).
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
 * Derive a skill ID from a parsed skill.
 *
 * Uses `frontmatter.name` when present, otherwise falls back
 * to the parent directory name of the SKILL.md file.
 */
function deriveSkillId(parsed: ParsedSkill): string {
  if (parsed.frontmatter.name) {
    return parsed.frontmatter.name;
  }
  // sourcePath is the absolute path to SKILL.md — take its parent dir name
  return basename(join(parsed.sourcePath, ".."));
}

/**
 * Check whether a skill meets its declared runtime dependencies.
 *
 * Checks (in order):
 * 1. `requires.os`  — current platform must be in the list
 * 2. `requires.bins` — every binary must be found on PATH (via `which`)
 * 3. `requires.env`  — every env var must be set in `process.env`
 *
 * Returns `{ eligible: true }` when all checks pass, or
 * `{ eligible: false, reason }` on the first failure.
 */
export function checkEligibility(skill: ParsedSkill): {
  eligible: boolean;
  reason?: string;
} {
  const requires = skill.frontmatter.requires;
  if (!requires) {
    return { eligible: true };
  }

  // OS check (synchronous)
  if (requires.os && requires.os.length > 0) {
    if (!requires.os.includes(process.platform)) {
      return {
        eligible: false,
        reason: `OS mismatch: requires [${requires.os.join(", ")}], current is ${process.platform}`,
      };
    }
  }

  // Env check (synchronous)
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

  // Bins check — we do a synchronous check using which.sync
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

  // Pip check — verify Python modules are importable
  if (requires.pip && requires.pip.length > 0) {
    let pythonBin = "python3";
    try {
      pythonBin = which.sync("python3");
    } catch {
      return {
        eligible: false,
        reason: "Required binary not found in PATH: python3 (needed for pip dependencies)",
      };
    }

    for (const pkg of requires.pip) {
      // Extract the module name (strip extras like "markitdown[pptx,pdf]" → "markitdown")
      const moduleName = pkg.replace(/\[.*\]$/, "").trim();
      try {
        execSync(`"${pythonBin}" -c "import ${moduleName}"`, {
          timeout: 10_000,
          stdio: "pipe",
        });
      } catch {
        // Module not importable — still eligible, but will be auto-installed at execution time
        console.debug(
          `[skills-discovery] Skill pip dependency "${moduleName}" not found, will auto-install at execution time`,
        );
      }
    }
  }

  return { eligible: true };
}

/** Priority weight for source types — higher number wins during deduplication */
const SOURCE_PRIORITY: Record<DiscoverySource["type"], number> = {
  personal: 1,
  additional: 2,
  project: 3,
};

/**
 * Scan the given discovery sources for SKILL.md files, parse them,
 * run eligibility checks, and return the deduplicated list.
 *
 * When multiple sources contain a skill with the same ID, the one
 * from the higher-priority source wins (project > additional > personal).
 *
 * Non-existent or inaccessible directories are silently skipped.
 * Individual SKILL.md parse failures are logged and skipped.
 */
export async function discoverSkills(
  sources: DiscoverySource[],
): Promise<DiscoveredSkill[]> {
  /** Map from skillId → best DiscoveredSkill (highest priority wins) */
  const skillMap = new Map<string, DiscoveredSkill>();

  for (const source of sources) {
    if (!(await isAccessible(source.basePath))) {
      console.debug(`[skills-discovery] Skipping inaccessible source: ${source.basePath}`);
      continue;
    }

    // Scan for all SKILL.md files under this source
    let skillPaths: string[];
    try {
      skillPaths = await fg("**/SKILL.md", {
        cwd: source.basePath,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: false,
      });
    } catch (err) {
      console.warn(`[skills-discovery] Error scanning ${source.basePath}:`, err);
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

      // Deduplication: higher-priority source wins
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
