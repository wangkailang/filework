/**
 * AI 技能运行时的技能注册表。
 *
 * 统一的注册表，同时管理内置技能与基于外部 SKILL.md 的技能。
 * 提供按 ID 查找、/command 匹配、基于 prompt 的匹配
 *（关键词 + 描述打分），以及过滤后的列表方法。
 */

import type { Skill } from "../skills/types";
import { buildDiscoverySources, discoverSkills } from "./discovery";
import type {
  DiscoveredSkill,
  DiscoverySource,
  SkillFrontmatter,
  UnifiedSkill,
} from "./types";

/** {@link SkillRegistry.listAllDiscovered} 返回的条目。 */
export interface DiscoveredSkillView {
  skillId: string;
  name: string;
  description: string;
  source: DiscoverySource;
  frontmatter: SkillFrontmatter;
  sourcePath: string;
  eligible: boolean;
  ineligibleReason?: string;
  /** 该技能当前是否已注册到运行时。 */
  enabled: boolean;
}

/**
 * 合并内置与外部技能的统一技能注册表。
 *
 * 外部技能在注册时被转换为 {@link UnifiedSkill}，
 * 并保留其发现来源与 frontmatter 元数据。
 */
export class SkillRegistry {
  /** 以技能 ID 为键的内部存储 —— 仅包含已注册/活跃的技能。 */
  private skills = new Map<string, UnifiedSkill>();

  /**
   * 曾发现过的所有外部技能（包括不符合条件的，以及来源当前被禁用的）。
   * 供技能弹窗展示完整清单使用。
   */
  private allDiscovered = new Map<string, DiscoveredSkill>();

  /**
   * 需要注册的 personal / additional 技能 ID 白名单。project
   * 与内置技能绕过此白名单 —— project 技能在符合条件时始终注册，
   * 内置技能始终注册。
   */
  private enabledSkillIds = new Set<string>();

  // ─── 注册 ────────────────────────────────────────────────

  /**
   * 注册内置技能。
   *
   * 每个 {@link Skill} 原样存储（UnifiedSkill 继承自 Skill，
   * 因此 `external` 为 `undefined`）。
   */
  registerBuiltIn(skills: Skill[]): void {
    for (const skill of skills) {
      this.skills.set(skill.id, skill as UnifiedSkill);
    }
  }

  /**
   * 注册从 SKILL.md 文件中发现的外部技能。
   *
   * 所有发现的技能都会记录到 {@link allDiscovered} 中，
   * 以便在技能弹窗中展示。只有同时满足
   *（a）符合条件且（b）来自 `project` 或位于
   * `enabledSkillIds` 白名单中的技能，才会被插入活跃的
   * {@link skills} map 并变为可在运行时调用。
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
   * 在运行时开启或关闭单个 personal / additional 技能。
   *
   * 内置与 project 技能无法切换，会被静默忽略。
   * 相应地更新内存中的白名单，并将技能加入/移出活跃注册表。
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

  /** 当前允许的 personal/additional 技能 ID 快照。 */
  getEnabledSkillIds(): string[] {
    return Array.from(this.enabledSkillIds);
  }

  // ─── 刷新 ─────────────────────────────────────────────────────

  /**
   * 当工作区变更时刷新 project 级别的技能。
   *
   * 先移除所有来源类型为 `"project"` 的技能，然后从新的
   * 工作区路径重新发现并重新注册 project 技能。
   */
  async refreshProjectSkills(workspacePath: string): Promise<void> {
    // 从两个存储中移除已有的 project 级别技能。
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

    // 仅重新发现 project 技能
    const sources = buildDiscoverySources(workspacePath);
    const projectSources = sources.filter((s) => s.type === "project");
    const discovered = await discoverSkills(projectSources);
    this.registerExternal(discovered);
  }

  // ─── 查找 ──────────────────────────────────────────────────────

  /** 按唯一标识符获取技能。 */
  getById(id: string): UnifiedSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * 查找已发现的外部技能 —— 包括被禁用和不符合条件的技能。
   * 供技能弹窗的详情视图使用，使得未启用的 personal/additional
   * 技能在用户选择启用前仍能展示其元数据与正文。
   */
  getDiscovered(id: string): DiscoveredSkill | undefined {
    return this.allDiscovered.get(id);
  }

  /**
   * 按 `/command` 名称匹配技能。
   *
   * 同时接受 `"skill-name"` 与 `"/skill-name"` 两种格式。
   */
  matchByCommand(command: string): UnifiedSkill | undefined {
    const name = command.startsWith("/") ? command.slice(1) : command;
    return this.skills.get(name);
  }

  /**
   * 使用统一打分为用户 prompt 匹配最佳技能。
   *
   * 采用与现有 `matchSkill` 函数相同的加权关键词算法：
   * 每个命中的关键词贡献其字符长度，外加每多命中一次奖励 3 分。
   *
   * 对内置技能（关键词匹配）和外部技能
   *（从描述派生关键词匹配）均适用。
   *
   * 设置了 `disable-model-invocation: true` 的技能会被跳过。
   */
  matchByPrompt(prompt: string): UnifiedSkill | undefined {
    const lower = prompt.toLowerCase();
    let best: UnifiedSkill | undefined;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      // 跳过选择退出 AI 自动调用的技能
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

      // 多关键词命中的奖励
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

  // ─── 列表 ─────────────────────────────────────────────────────

  /**
   * 列出对用户可见的技能。
   *
   * 排除 `user-invocable` 被显式设为 `false` 的技能。
   */
  listUserVisible(): UnifiedSkill[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.external?.frontmatter["user-invocable"] !== false,
    );
  }

  /** 列出所有已注册的技能（供 IPC 使用）。 */
  listAll(): UnifiedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 列出曾发现过的每个外部技能，包括来源当前被禁用的，
   * 或未通过资格检查的技能。
   *
   * 每个条目携带 `enabled` 标志，表示该技能当前是否在运行时
   * 注册表中处于活跃状态。技能弹窗据此展示完整清单并标注
   *“已禁用”徽章。
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

  // ─── 内部辅助函数 ────────────────────────────────────────────

  /** 判断一个已发现的技能是否应被插入活跃 map。 */
  private shouldRegister(d: DiscoveredSkill): boolean {
    if (!d.eligible) return false;
    const t = d.source.type;
    if (t === "project") return true;
    if (t === "personal" || t === "additional") {
      return this.enabledSkillIds.has(d.skillId);
    }
    return false;
  }

  /** 将 {@link DiscoveredSkill} 转换为 {@link UnifiedSkill}。 */
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

// ─── 辅助函数 ─────────────────────────────────────────────────────────

/**
 * 从描述字符串中提取关键词。
 *
 * 按空白字符分割，过滤掉短词（≤ 2 个字符），
 * 并返回去重后的小写词元。
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
