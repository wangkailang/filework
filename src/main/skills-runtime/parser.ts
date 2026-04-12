/**
 * Parser module for SKILL.md files.
 *
 * Provides `parseSkillMd` to parse SKILL.md content (YAML frontmatter + Markdown body)
 * into a structured `ParsedSkill`, and `printSkillMd` to format it back.
 */

import matter from "gray-matter";

import type { ParsedSkill, SkillFrontmatter } from "./types";
import { SkillParseError, SkillValidationError } from "./types";

/** Regex for valid kebab-case name: lowercase alphanumeric segments separated by hyphens */
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maximum allowed length for the `name` field */
const MAX_NAME_LENGTH = 64;

/**
 * Pick only the recognised `SkillFrontmatter` fields from a raw object,
 * silently discarding anything unknown.
 */
function pickKnownFields(raw: Record<string, unknown>): SkillFrontmatter {
  const fm: SkillFrontmatter = {};

  if (typeof raw.name === "string") {
    fm.name = raw.name;
  }
  if (typeof raw.description === "string") {
    fm.description = raw.description;
  }
  if (typeof raw.model === "string") {
    fm.model = raw.model;
  }
  if (raw.context === "default" || raw.context === "fork") {
    fm.context = raw.context;
  }
  if (Array.isArray(raw["allowed-tools"])) {
    fm["allowed-tools"] = raw["allowed-tools"].filter(
      (t): t is string => typeof t === "string",
    );
  }
  if (typeof raw["disable-model-invocation"] === "boolean") {
    fm["disable-model-invocation"] = raw["disable-model-invocation"];
  }
  if (typeof raw["user-invocable"] === "boolean") {
    fm["user-invocable"] = raw["user-invocable"];
  }
  if (raw.requires != null && typeof raw.requires === "object") {
    const req = raw.requires as Record<string, unknown>;
    const requires: SkillFrontmatter["requires"] = {};
    if (Array.isArray(req.bins)) {
      requires.bins = req.bins.filter(
        (b): b is string => typeof b === "string",
      );
    }
    if (Array.isArray(req.env)) {
      requires.env = req.env.filter((e): e is string => typeof e === "string");
    }
    if (Array.isArray(req.os)) {
      requires.os = req.os.filter((o): o is string => typeof o === "string");
    }
    if (Array.isArray(req.pip)) {
      requires.pip = req.pip.filter((p): p is string => typeof p === "string");
    }
    if (Object.keys(requires).length > 0) {
      fm.requires = requires;
    }
  }
  if (raw.hooks != null && typeof raw.hooks === "object") {
    const h = raw.hooks as Record<string, unknown>;
    const hooks: NonNullable<SkillFrontmatter["hooks"]> = {};
    if (typeof h["pre-activate"] === "string") {
      hooks["pre-activate"] = h["pre-activate"];
    }
    if (typeof h["post-complete"] === "string") {
      hooks["post-complete"] = h["post-complete"];
    }
    if (Object.keys(hooks).length > 0) {
      fm.hooks = hooks;
    }
  }

  return fm;
}

/**
 * Parse SKILL.md file content into a structured `ParsedSkill`.
 *
 * - Uses `gray-matter` to split YAML frontmatter from Markdown body.
 * - When no frontmatter is present the entire content becomes the body
 *   and frontmatter defaults to `{}`.
 * - Validates the `name` field (kebab-case, ≤ 64 chars).
 * - Unrecognised frontmatter fields are silently ignored.
 * - Empty content throws `SkillParseError`.
 *
 * @throws {SkillParseError} when content is empty or YAML is malformed
 * @throws {SkillValidationError} when `name` fails validation
 */
export function parseSkillMd(content: string, sourcePath: string): ParsedSkill {
  if (!content || content.trim().length === 0) {
    throw new SkillParseError(sourcePath, "empty file");
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillParseError(sourcePath, `YAML parse error: ${message}`);
  }

  // Extract only known fields from the raw frontmatter data
  const rawData = parsed.data as Record<string, unknown>;
  const hasAnyFrontmatter = Object.keys(rawData).length > 0;
  const frontmatter = hasAnyFrontmatter ? pickKnownFields(rawData) : {};

  // Validate name field if present
  if (frontmatter.name !== undefined) {
    if (!KEBAB_CASE_RE.test(frontmatter.name)) {
      throw new SkillValidationError(
        sourcePath,
        "name",
        `must be kebab-case (lowercase alphanumeric segments separated by hyphens), got "${frontmatter.name}"`,
      );
    }
    if (frontmatter.name.length > MAX_NAME_LENGTH) {
      throw new SkillValidationError(
        sourcePath,
        "name",
        `must be at most ${MAX_NAME_LENGTH} characters, got ${frontmatter.name.length}`,
      );
    }
  }

  return {
    frontmatter,
    body: parsed.content,
    sourcePath,
  };
}

/**
 * Format a `ParsedSkill` back into SKILL.md file content.
 *
 * - If frontmatter has any fields, outputs a YAML frontmatter block
 *   (`---\n…\n---\n`) followed by the body.
 * - If frontmatter is an empty object, outputs just the body.
 * - Ensures roundtrip consistency: `parseSkillMd(printSkillMd(skill))`
 *   produces an equivalent result.
 */
export function printSkillMd(skill: ParsedSkill): string {
  const hasFields = Object.keys(skill.frontmatter).length > 0;

  if (!hasFields) {
    return skill.body;
  }

  // Use gray-matter's stringify to produce the YAML frontmatter block
  return matter.stringify(skill.body, skill.frontmatter);
}
