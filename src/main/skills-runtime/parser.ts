/**
 * SKILL.md 文件的解析器模块。
 *
 * 提供 `parseSkillMd` 将 SKILL.md 内容(YAML frontmatter + Markdown 正文)
 * 解析为结构化的 `ParsedSkill`,并提供 `printSkillMd` 将其格式化回原样。
 */

import matter from "gray-matter";

import type { ParsedSkill, SkillFrontmatter } from "./types";
import { SkillParseError, SkillValidationError } from "./types";

/** 校验合法 kebab-case 名称的正则:用连字符分隔的小写字母数字段 */
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `name` 字段允许的最大长度 */
const MAX_NAME_LENGTH = 64;

/**
 * 仅从原始对象中挑选已识别的 `SkillFrontmatter` 字段,
 * 静默丢弃任何未知字段。
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
  if (typeof raw.reflect === "boolean") {
    fm.reflect = raw.reflect;
  }

  return fm;
}

/**
 * 将 SKILL.md 文件内容解析为结构化的 `ParsedSkill`。
 *
 * - 使用 `gray-matter` 从 Markdown 正文中分离 YAML frontmatter。
 * - 当不存在 frontmatter 时,整个内容作为正文,
 *   frontmatter 默认为 `{}`。
 * - 校验 `name` 字段(kebab-case,≤ 64 字符)。
 * - 未识别的 frontmatter 字段会被静默忽略。
 * - 空内容会抛出 `SkillParseError`。
 *
 * @throws {SkillParseError} 当内容为空或 YAML 格式错误时
 * @throws {SkillValidationError} 当 `name` 校验失败时
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

  // 仅从原始 frontmatter 数据中提取已知字段
  const rawData = parsed.data as Record<string, unknown>;
  const hasAnyFrontmatter = Object.keys(rawData).length > 0;
  const frontmatter = hasAnyFrontmatter ? pickKnownFields(rawData) : {};

  // 如果存在 name 字段则进行校验
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
 * 将 `ParsedSkill` 格式化回 SKILL.md 文件内容。
 *
 * - 若 frontmatter 含有任意字段,输出一个 YAML frontmatter 块
 *   (`---\n…\n---\n`)后接正文。
 * - 若 frontmatter 为空对象,则仅输出正文。
 * - 确保往返一致性:`parseSkillMd(printSkillMd(skill))`
 *   会产生等价的结果。
 */
export function printSkillMd(skill: ParsedSkill): string {
  const hasFields = Object.keys(skill.frontmatter).length > 0;

  if (!hasFields) {
    return skill.body;
  }

  // 使用 gray-matter 的 stringify 生成 YAML frontmatter 块
  return matter.stringify(skill.body, skill.frontmatter);
}
