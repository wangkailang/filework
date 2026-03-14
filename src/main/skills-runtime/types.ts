import type { Skill } from "../skills/types";

// ─── SKILL.md Frontmatter ────────────────────────────────────────────

/** Fields supported in the YAML frontmatter of a SKILL.md file. */
export interface SkillFrontmatter {
  /** kebab-case identifier, max 64 characters */
  name?: string;
  /** Skill description used for AI matching */
  description?: string;
  /** Model override, e.g. "claude-sonnet-4-20250514" */
  model?: string;
  /** Execution context mode */
  context?: "default" | "fork";
  /** Tools allowed in fork mode (no approval required) */
  "allowed-tools"?: string[];
  /** When true, AI will not auto-invoke this skill */
  "disable-model-invocation"?: boolean;
  /** Whether the skill appears in the user menu (default true) */
  "user-invocable"?: boolean;
  /** Runtime dependency declarations for eligibility gating */
  requires?: {
    /** Required binaries (checked against PATH) */
    bins?: string[];
    /** Required environment variables */
    env?: string[];
    /** Supported operating systems (darwin/linux/win32) */
    os?: string[];
    /** Required Python packages (checked via pip, auto-installed if missing) */
    pip?: string[];
  };
  /** Lifecycle hook scripts */
  hooks?: {
    /** Script to run before skill activation */
    "pre-activate"?: string;
    /** Script to run after skill completion */
    "post-complete"?: string;
  };
}

// ─── Parsed Skill ────────────────────────────────────────────────────

/** Result of parsing a SKILL.md file. */
export interface ParsedSkill {
  /** Parsed YAML frontmatter metadata */
  frontmatter: SkillFrontmatter;
  /** Markdown body content */
  body: string;
  /** Absolute path to the SKILL.md file */
  sourcePath: string;
}

// ─── Discovery ───────────────────────────────────────────────────────

/** A source location from which skills are discovered. */
export interface DiscoverySource {
  type: "personal" | "project" | "additional";
  /** Root path that was scanned */
  basePath: string;
}

/** A skill found during the discovery phase. */
export interface DiscoveredSkill {
  parsed: ParsedSkill;
  source: DiscoverySource;
  /** Skill identifier: frontmatter.name or directory name */
  skillId: string;
  /** Whether the skill passed eligibility checks */
  eligible: boolean;
  /** Reason the skill is ineligible (when eligible === false) */
  ineligibleReason?: string;
}

// ─── Unified Skill ───────────────────────────────────────────────────

/**
 * Unified skill interface that is a superset of the built-in {@link Skill}.
 *
 * Built-in skills have `external` as `undefined`.
 * External skills carry their discovery metadata in the `external` field.
 */
export interface UnifiedSkill extends Skill {
  /** Present only for external (SKILL.md-based) skills */
  external?: {
    source: DiscoverySource;
    frontmatter: SkillFrontmatter;
    body: string;
    sourcePath: string;
  };
}

// ─── Trust / Security ────────────────────────────────────────────────

/** Persisted trust record for an external skill. */
export interface SkillTrustRecord {
  skillId: string;
  sourcePath: string;
  /** SHA-256 hash of SKILL.md + associated hook scripts */
  contentHash: string;
  /** Whether the user has approved this skill */
  approved: boolean;
  /** ISO-8601 timestamp of approval */
  approvedAt?: string;
  /** Granular permissions granted during approval */
  permissions: {
    /** Allow !command dynamic context execution */
    allowCommands: boolean;
    /** Allow lifecycle hook script execution */
    allowHooks: boolean;
  };
}

// ─── Preprocessor ────────────────────────────────────────────────────

/** Result of preprocessing a skill's body content. */
export interface PreprocessResult {
  /** The processed system prompt ready for injection */
  systemPrompt: string;
  /** Whether the content was truncated to fit the limit */
  truncated: boolean;
  /** Non-fatal warnings encountered during preprocessing */
  warnings: string[];
}

// ─── Error Classes ───────────────────────────────────────────────────

/**
 * Thrown when a SKILL.md file cannot be parsed
 * (empty file, unreadable, malformed YAML, etc.).
 */
export class SkillParseError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly reason: string,
  ) {
    super(`Failed to parse SKILL.md at ${sourcePath}: ${reason}`);
    this.name = "SkillParseError";
  }
}

/**
 * Thrown when parsed frontmatter values fail validation
 * (e.g. name is not kebab-case or exceeds 64 characters).
 */
export class SkillValidationError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Validation error in ${sourcePath} [${field}]: ${reason}`);
    this.name = "SkillValidationError";
  }
}
