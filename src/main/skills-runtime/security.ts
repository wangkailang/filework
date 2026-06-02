/**
 * AI 技能运行时的安全模块。
 *
 * 为外部 SKILL.md 技能提供信任管理、内容哈希、环境变量过滤,
 * 以及命令的允许/阻止名单。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoverySource, ParsedSkill, SkillTrustRecord } from "./types";

// ─── 命令前缀 ────────────────────────────────────────────────

/** 对高/中信任级别技能视为安全的只读命令。 */
export const SAFE_COMMAND_PREFIXES: readonly string[] = [
  "cat",
  "ls",
  "echo",
  "head",
  "tail",
  "wc",
  "git log",
  "git status",
  "git diff",
  "git branch",
  "node --version",
  "npm --version",
  "python --version",
];

/** 无论信任级别如何都始终被阻止的危险命令。 */
export const BLOCKED_COMMAND_PREFIXES: readonly string[] = [
  "curl",
  "wget",
  "nc",
  "ssh",
  "scp",
  "rm",
  "sudo",
  "chmod",
  "chown",
  "open",
  "osascript",
  "pbcopy",
];

// ─── 敏感环境变量模式 ──────────────────────────────────────

/** 应被过滤掉的环境变量名的正则模式。 */
const SENSITIVE_ENV_PATTERNS = [
  /_API_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
];

/** 始终过滤的敏感环境变量的显式列表。 */
const SENSITIVE_ENV_EXPLICIT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
]);

/** 在安全环境中始终保留的基础环境变量。 */
const SAFE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "SHELL",
  "USER",
  "TERM",
]);

// ─── 信任存储（内存中）─────────────────────────────────────────

/** 以 skillId 为键的技能信任记录内存 map。 */
const trustStore = new Map<string, SkillTrustRecord>();

// ─── 信任级别 ─────────────────────────────────────────────────────

/** 从技能发现来源派生出的信任级别。 */
export type TrustLevel = "high" | "medium" | "low";

/**
 * 将 {@link DiscoverySource} 类型映射为信任级别。
 *
 * - `project` (.agents/skills/) → high
 * - `personal` (~/.agents/skills/) → medium
 * - `additional` → low
 */
export function getTrustLevel(sourceType: DiscoverySource["type"]): TrustLevel {
  switch (sourceType) {
    case "project":
      return "high";
    case "personal":
      return "medium";
    case "additional":
      return "low";
  }
}

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 计算技能内容（SKILL.md + hook 脚本）的 SHA-256 哈希。
 *
 * 读取 SKILL.md 文件；若 frontmatter 中定义了 hook，
 * 则同时读取 hook 脚本文件。所有内容拼接后进行哈希，
 * 生成十六进制摘要。
 *
 * @param skillDir - 包含 SKILL.md 的技能目录的绝对路径
 */
export async function computeSkillHash(skillDir: string): Promise<string> {
  const parts: string[] = [];

  // 始终读取 SKILL.md
  const skillMdPath = join(skillDir, "SKILL.md");
  const skillContent = await readFile(skillMdPath, "utf-8");
  parts.push(skillContent);

  // 若 hook 脚本与 SKILL.md 同目录存在，则尝试读取它们。
  // 我们解析 SKILL.md 以找到 hook 路径，但为避免循环依赖，
  // 仅对 frontmatter 中的 hook 做轻量扫描
  const { parseSkillMd } = await import("./parser");
  try {
    const parsed = parseSkillMd(skillContent, skillMdPath);
    const hooks = parsed.frontmatter.hooks;
    if (hooks) {
      for (const hookPath of [hooks["pre-activate"], hooks["post-complete"]]) {
        if (hookPath) {
          try {
            const resolvedPath = join(skillDir, hookPath);
            const hookContent = await readFile(resolvedPath, "utf-8");
            parts.push(hookContent);
          } catch {
            // hook 文件不存在或无法读取 —— 跳过
          }
        }
      }
    }
  } catch {
    // 若解析失败，则仅对原始 SKILL.md 内容进行哈希
  }

  const hash = createHash("sha256");
  hash.update(parts.join(""));
  return hash.digest("hex");
}

/**
 * 检查技能当前是否受信任。
 *
 * 仅当满足以下条件时技能才受信任：
 * 1. 给定 skillId 存在信任记录
 * 2. 该记录被标记为已批准
 * 3. 存储的内容哈希与当前哈希一致
 *
 * @param skillId - 技能的唯一标识符
 * @param currentHash - 刚计算出的内容哈希
 */
export function isSkillTrusted(skillId: string, currentHash: string): boolean {
  const record = trustStore.get(skillId);
  if (!record) {
    return false;
  }
  return record.approved && record.contentHash === currentHash;
}

/**
 * 通过 IPC 请求用户对技能进行批准。
 *
 * 向渲染进程发送批准请求并等待用户响应。批准后，
 * 将信任记录存入内存信任存储。
 *
 * 这是一个占位实现，后续将完整接入 IPC。
 * 当前使用 `sender.send('skill:approval-request', ...)` 模式。
 *
 * @param sender - 用于发送 IPC 消息的 Electron WebContents
 * @param skill - 请求批准的已解析技能
 * @param commands - 技能中发现的 !command 字符串列表
 * @param hooks - 技能中发现的 hook 脚本路径列表
 */
export async function requestSkillApproval(
  sender: Electron.WebContents,
  skill: ParsedSkill,
  commands: string[],
  hooks: string[],
): Promise<SkillTrustRecord> {
  const skillId = skill.frontmatter.name || "";
  const skillDir = join(skill.sourcePath, "..");

  // 计算当前内容哈希
  let contentHash: string;
  try {
    contentHash = await computeSkillHash(skillDir);
  } catch {
    contentHash = "";
  }

  // 向渲染进程发送批准请求
  sender.send("skill:approval-request", {
    skillId,
    sourcePath: skill.sourcePath,
    commands,
    hooks,
  });

  // 创建信任记录（占位 —— 在真正的实现中，
  // 这里会等待用户的 IPC 响应）
  const record: SkillTrustRecord = {
    skillId,
    sourcePath: skill.sourcePath,
    contentHash,
    approved: true,
    approvedAt: new Date().toISOString(),
    permissions: {
      allowCommands: commands.length > 0,
      allowHooks: hooks.length > 0,
    },
  };

  // 存入内存信任 map
  trustStore.set(skillId, record);

  return record;
}

/**
 * 为 !command 执行构建安全的环境变量 map。
 *
 * 过滤掉匹配 `*_API_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD`
 * 等模式的敏感变量，以及一份显式黑名单。
 * 仅保留基础系统变量（PATH、HOME、LANG、SHELL、USER、TERM）
 * 以及所有非敏感变量。
 */
export function buildSafeEnv(): Record<string, string> {
  const safeEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    // 始终保留安全的系统变量
    if (SAFE_ENV_VARS.has(key)) {
      safeEnv[key] = value;
      continue;
    }

    // 过滤显式列出的敏感变量
    if (SENSITIVE_ENV_EXPLICIT.has(key)) {
      continue;
    }

    // 过滤模式匹配的敏感变量
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }

    // 保留其余所有变量
    safeEnv[key] = value;
  }

  return safeEnv;
}

/**
 * 在给定信任级别下检查命令是否允许执行。
 *
 * 规则：
 * - 被阻止的命令无论信任级别如何始终返回 `false`
 * - 低信任：所有命令都被阻止（返回 `false`）
 * - 安全命令在高/中信任级别下返回 `true`
 * - 未知命令（不在安全或阻止名单中）：
 *   - `high` 信任 → `true`
 *   - `medium` / `low` 信任 → `false`
 *
 * @param command - 待检查的 shell 命令字符串
 * @param trustLevel - 技能来源的信任级别
 */
export function isCommandAllowed(
  command: string,
  trustLevel: TrustLevel,
): boolean {
  const trimmed = command.trim();

  // 被阻止的命令始终被拒绝
  if (BLOCKED_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return false;
  }

  // 低信任：一切都被阻止
  if (trustLevel === "low") {
    return false;
  }

  // 安全命令在高/中信任级别下被允许
  if (SAFE_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }

  // 未知命令：仅在高信任级别下被允许
  return trustLevel === "high";
}

// ─── 测试辅助函数 ────────────────────────────────────────────────────

/**
 * 清空内存信任存储。仅为测试目的暴露。
 * @internal
 */
export function _clearTrustStore(): void {
  trustStore.clear();
}

/**
 * 直接设置一条信任记录。仅为测试目的暴露。
 * @internal
 */
export function _setTrustRecord(
  skillId: string,
  record: SkillTrustRecord,
): void {
  trustStore.set(skillId, record);
}
