import type { Skill } from "../skills/types";

// ─── SKILL.md Frontmatter ────────────────────────────────────────────

/** SKILL.md 文件 YAML frontmatter 中支持的字段。 */
export interface SkillFrontmatter {
  /** kebab-case 标识符，最多 64 个字符 */
  name?: string;
  /** 用于 AI 匹配的技能描述 */
  description?: string;
  /** 模型覆盖，例如 "claude-sonnet-4-20250514" */
  model?: string;
  /** 执行上下文模式 */
  context?: "default" | "fork";
  /** fork 模式下允许使用的工具（无需批准） */
  "allowed-tools"?: string[];
  /** 为 true 时，AI 不会自动调用此技能 */
  "disable-model-invocation"?: boolean;
  /** 技能是否出现在用户菜单中（默认 true） */
  "user-invocable"?: boolean;
  /** 用于资格门控的运行时依赖声明 */
  requires?: {
    /** 所需的可执行文件（对照 PATH 检查） */
    bins?: string[];
    /** 所需的环境变量 */
    env?: string[];
    /** 支持的操作系统（darwin/linux/win32） */
    os?: string[];
    /** 所需的 Python 包（通过 pip 检查，缺失时自动安装） */
    pip?: string[];
  };
  /** 生命周期 hook 脚本 */
  hooks?: {
    /** 技能激活前运行的脚本 */
    "pre-activate"?: string;
    /** 技能完成后运行的脚本 */
    "post-complete"?: string;
  };
  /**
   * 让此技能加入回合后反思门控。为 true 时，
   * AgentLoop 会在每次 `streamText` 调用后执行一次裁定检查，
   * 并可携带反馈最多重试 `maxReflections` 次。
   * 每回合会额外消耗一次廉价模型调用。
   */
  reflect?: boolean;
}

// ─── Parsed Skill ────────────────────────────────────────────────────

/** 解析 SKILL.md 文件的结果。 */
export interface ParsedSkill {
  /** 解析出的 YAML frontmatter 元数据 */
  frontmatter: SkillFrontmatter;
  /** Markdown 正文内容 */
  body: string;
  /** SKILL.md 文件的绝对路径 */
  sourcePath: string;
}

// ─── Discovery ───────────────────────────────────────────────────────

/** 发现技能的来源位置。 */
export interface DiscoverySource {
  type: "personal" | "project" | "additional";
  /** 被扫描的根路径 */
  basePath: string;
}

/** 在发现阶段找到的技能。 */
export interface DiscoveredSkill {
  parsed: ParsedSkill;
  source: DiscoverySource;
  /** 技能标识符：frontmatter.name 或目录名 */
  skillId: string;
  /** 技能是否通过资格检查 */
  eligible: boolean;
  /** 技能不符合资格的原因（当 eligible === false 时） */
  ineligibleReason?: string;
}

// ─── Unified Skill ───────────────────────────────────────────────────

/**
 * 统一技能接口，是内置 {@link Skill} 的超集。
 *
 * 内置技能的 `external` 为 `undefined`。
 * 外部技能在 `external` 字段中携带其发现元数据。
 */
export interface UnifiedSkill extends Skill {
  /** 仅对外部（基于 SKILL.md 的）技能存在 */
  external?: {
    source: DiscoverySource;
    frontmatter: SkillFrontmatter;
    body: string;
    sourcePath: string;
  };
}

// ─── Trust / Security ────────────────────────────────────────────────

/** 外部技能的持久化信任记录。 */
export interface SkillTrustRecord {
  skillId: string;
  sourcePath: string;
  /** SKILL.md + 关联 hook 脚本的 SHA-256 哈希 */
  contentHash: string;
  /** 用户是否已批准此技能 */
  approved: boolean;
  /** 批准的 ISO-8601 时间戳 */
  approvedAt?: string;
  /** 批准时授予的细粒度权限 */
  permissions: {
    /** 允许 !command 动态上下文执行 */
    allowCommands: boolean;
    /** 允许执行生命周期 hook 脚本 */
    allowHooks: boolean;
  };
}

// ─── Preprocessor ────────────────────────────────────────────────────

/** 预处理技能正文内容的结果。 */
export interface PreprocessResult {
  /** 处理完成、可供注入的系统提示 */
  systemPrompt: string;
  /** 内容是否为适配上限而被截断 */
  truncated: boolean;
  /** 预处理过程中遇到的非致命警告 */
  warnings: string[];
}

// ─── Error Classes ───────────────────────────────────────────────────

/**
 * 当 SKILL.md 文件无法被解析时抛出
 *（空文件、不可读、YAML 格式错误等）。
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
 * 当解析出的 frontmatter 值未通过校验时抛出
 *（例如 name 不是 kebab-case 或超过 64 个字符）。
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
