/**
 * Skill Registry for AI Skills Runtime.
 *
 * Unified registry that manages both built-in skills and external
 * SKILL.md-based skills. Provides lookup by ID, /command matching,
 * prompt-based matching (keyword + description scoring), and
 * filtered listing methods.
 */

import type { Skill } from "../skills/types";
import { buildDiscoverySources, discoverSkills } from "./discovery";
import type { DiscoveredSkill, UnifiedSkill } from "./types";

/**
 * Unified skill registry that merges built-in and external skills.
 *
 * External skills are converted to {@link UnifiedSkill} on registration,
 * preserving their discovery source and frontmatter metadata.
 */
export class SkillRegistry {
  /** Internal store keyed by skill ID */
  private skills = new Map<string, UnifiedSkill>();

  // ─── Registration ────────────────────────────────────────────────

  /**
   * Register built-in skills.
   *
   * Each {@link Skill} is stored as-is (UnifiedSkill extends Skill,
   * so `external` will be `undefined`).
   */
  registerBuiltIn(skills: Skill[]): void {
    for (const skill of skills) {
      this.skills.set(skill.id, skill as UnifiedSkill);
    }
  }

  /**
   * Register external skills discovered from SKILL.md files.
   *
   * Only eligible skills are registered. Each {@link DiscoveredSkill}
   * is converted to a {@link UnifiedSkill}, preserving the discovery
   * source and priority order.
   */
  registerExternal(discovered: DiscoveredSkill[]): void {
    for (const d of discovered) {
      if (!d.eligible) {
        continue;
      }

      const { parsed, source, skillId } = d;
      const fm = parsed.frontmatter;

      const unified: UnifiedSkill = {
        id: skillId,
        name: fm.name ?? skillId,
        description: fm.description ?? "",
        keywords: extractKeywords(fm.description ?? ""),
        systemPrompt: parsed.body,
        external: {
          source,
          frontmatter: fm,
          body: parsed.body,
          sourcePath: parsed.sourcePath,
        },
      };

      this.skills.set(skillId, unified);
    }
  }

  // ─── Refresh ─────────────────────────────────────────────────────

  /**
   * Refresh project-level skills when the workspace changes.
   *
   * Removes all skills whose source type is `"project"`, then
   * re-discovers and re-registers project skills from the new
   * workspace path.
   */
  async refreshProjectSkills(workspacePath: string): Promise<void> {
    // Remove existing project-level skills
    for (const [id, skill] of this.skills) {
      if (skill.external?.source.type === "project") {
        this.skills.delete(id);
      }
    }

    // Re-discover project skills only
    const sources = buildDiscoverySources(workspacePath);
    const projectSources = sources.filter((s) => s.type === "project");
    const discovered = await discoverSkills(projectSources);
    this.registerExternal(discovered);
  }

  // ─── Lookup ──────────────────────────────────────────────────────

  /** Get a skill by its unique identifier. */
  getById(id: string): UnifiedSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * Match a skill by `/command` name.
   *
   * Accepts both `"skill-name"` and `"/skill-name"` formats.
   */
  matchByCommand(command: string): UnifiedSkill | undefined {
    const name = command.startsWith("/") ? command.slice(1) : command;
    return this.skills.get(name);
  }

  /**
   * Match the best skill for a user prompt using unified scoring.
   *
   * Uses the same weighted keyword algorithm as the existing
   * `matchSkill` function: each matched keyword contributes its
   * character length, plus a bonus of 3 per additional hit.
   *
   * Works for both built-in skills (keyword matching) and external
   * skills (description-derived keyword matching).
   *
   * Skills with `disable-model-invocation: true` are skipped.
   */
  matchByPrompt(prompt: string): UnifiedSkill | undefined {
    const lower = prompt.toLowerCase();
    let best: UnifiedSkill | undefined;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      // Skip skills that opt out of AI auto-invocation
      if (skill.external?.frontmatter["disable-model-invocation"] === true) {
        continue;
      }

      let score = 0;
      let hits = 0;

      for (const kw of skill.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          score += kw.length;
          hits++;
        }
      }

      // Bonus for multiple keyword matches
      if (hits > 1) {
        score += (hits - 1) * 3;
      }

      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }

    return bestScore > 0 ? best : undefined;
  }

  // ─── Listing ─────────────────────────────────────────────────────

  /**
   * List skills visible to the user.
   *
   * Excludes skills where `user-invocable` is explicitly `false`.
   */
  listUserVisible(): UnifiedSkill[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.external?.frontmatter["user-invocable"] !== false,
    );
  }

  /** List all registered skills (for IPC). */
  listAll(): UnifiedSkill[] {
    return Array.from(this.skills.values());
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract keywords from a description string.
 *
 * Splits on whitespace, filters out short words (≤ 2 chars),
 * and returns unique lowercase tokens.
 */
function extractKeywords(description: string): string[] {
  if (!description) {
    return [];
  }

  const words = description
    .split(/\s+/)
    .map((w) => w.replace(/[^\w-]/g, ""))
    .filter((w) => w.length > 2);

  return [...new Set(words)];
}
