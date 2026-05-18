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
import type {
  DiscoveredSkill,
  DiscoverySource,
  SkillFrontmatter,
  UnifiedSkill,
} from "./types";

/** Entry returned by {@link SkillRegistry.listAllDiscovered}. */
export interface DiscoveredSkillView {
  skillId: string;
  name: string;
  description: string;
  source: DiscoverySource;
  frontmatter: SkillFrontmatter;
  sourcePath: string;
  eligible: boolean;
  ineligibleReason?: string;
  /** Whether this skill is currently registered into the runtime. */
  enabled: boolean;
}

/**
 * Unified skill registry that merges built-in and external skills.
 *
 * External skills are converted to {@link UnifiedSkill} on registration,
 * preserving their discovery source and frontmatter metadata.
 */
export class SkillRegistry {
  /** Internal store keyed by skill ID — only registered/active skills. */
  private skills = new Map<string, UnifiedSkill>();

  /**
   * All external skills ever discovered (including ineligible ones and
   * those whose source is currently disabled). Used by the Skills modal
   * to show the full inventory.
   */
  private allDiscovered = new Map<string, DiscoveredSkill>();

  /**
   * Allow-list of personal / additional skill IDs to register. Project
   * and built-in skills bypass this list — project skills are always
   * registered when eligible, built-ins are always registered.
   */
  private enabledSkillIds = new Set<string>();

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
   * All discovered skills are always recorded in {@link allDiscovered}
   * so they can be surfaced in the Skills modal. Only skills that are
   * (a) eligible and (b) either from `project` or in the
   * `enabledSkillIds` allow-list get inserted into the active
   * {@link skills} map and become runtime-callable.
   */
  registerExternal(
    discovered: DiscoveredSkill[],
    opts?: { enabledSkillIds?: Iterable<string> },
  ): void {
    if (opts?.enabledSkillIds) {
      this.enabledSkillIds = new Set(opts.enabledSkillIds);
    }

    for (const d of discovered) {
      this.allDiscovered.set(d.skillId, d);

      if (!this.shouldRegister(d)) {
        continue;
      }

      this.skills.set(d.skillId, this.buildUnified(d));
    }
  }

  /**
   * Toggle a single personal / additional skill on or off at runtime.
   *
   * Built-in and project skills cannot be toggled and are silently
   * ignored. Updates the in-memory allow-list and adds/removes the
   * skill from the active registry accordingly.
   */
  setSkillEnabled(skillId: string, enabled: boolean): void {
    const discovered = this.allDiscovered.get(skillId);
    if (!discovered) return;
    const t = discovered.source.type;
    if (t !== "personal" && t !== "additional") return;

    if (enabled) {
      this.enabledSkillIds.add(skillId);
      if (discovered.eligible) {
        this.skills.set(skillId, this.buildUnified(discovered));
      }
    } else {
      this.enabledSkillIds.delete(skillId);
      this.skills.delete(skillId);
    }
  }

  /** Snapshot of the currently-allowed personal/additional skill IDs. */
  getEnabledSkillIds(): string[] {
    return Array.from(this.enabledSkillIds);
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
    // Remove existing project-level skills from both stores.
    for (const [id, skill] of this.skills) {
      if (skill.external?.source.type === "project") {
        this.skills.delete(id);
      }
    }
    for (const [id, d] of this.allDiscovered) {
      if (d.source.type === "project") {
        this.allDiscovered.delete(id);
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
   * Look up a discovered external skill — including disabled and
   * ineligible ones. Used by the Skills modal detail view so that
   * unenabled personal/additional skills can still display their
   * metadata and body before the user opts in.
   */
  getDiscovered(id: string): DiscoveredSkill | undefined {
    return this.allDiscovered.get(id);
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

  /**
   * List skills tagged with the given frontmatter `category`.
   *
   * Use `listByCategory("process")` to fetch the workflow-discipline
   * skills (e.g. `using-superpowers`, `brainstorming`) that must always
   * be injected into the system prompt — distinct from task/tool skills
   * which compete for prompt-based selection.
   */
  listByCategory(
    category: NonNullable<SkillFrontmatter["category"]>,
  ): UnifiedSkill[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.external?.frontmatter.category === category,
    );
  }

  /**
   * List every external skill ever discovered, including those whose
   * source is currently disabled or that failed eligibility checks.
   *
   * Each entry carries an `enabled` flag indicating whether the skill
   * is presently active in the runtime registry. The Skills modal uses
   * this to show the full inventory with "disabled" badges.
   */
  listAllDiscovered(): DiscoveredSkillView[] {
    const out: DiscoveredSkillView[] = [];
    for (const d of this.allDiscovered.values()) {
      out.push({
        skillId: d.skillId,
        name: d.parsed.frontmatter.name ?? d.skillId,
        description: d.parsed.frontmatter.description ?? "",
        source: d.source,
        frontmatter: d.parsed.frontmatter,
        sourcePath: d.parsed.sourcePath,
        eligible: d.eligible,
        ineligibleReason: d.ineligibleReason,
        enabled: this.skills.has(d.skillId),
      });
    }
    return out;
  }

  // ─── Internal helpers ────────────────────────────────────────────

  /** Whether a discovered skill should be inserted into the active map. */
  private shouldRegister(d: DiscoveredSkill): boolean {
    if (!d.eligible) return false;
    const t = d.source.type;
    if (t === "project") return true;
    if (t === "personal" || t === "additional") {
      return this.enabledSkillIds.has(d.skillId);
    }
    return false;
  }

  /** Convert a {@link DiscoveredSkill} into a {@link UnifiedSkill}. */
  private buildUnified(d: DiscoveredSkill): UnifiedSkill {
    const { parsed, source, skillId } = d;
    const fm = parsed.frontmatter;
    return {
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
