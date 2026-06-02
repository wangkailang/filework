import type { Tool } from "ai";

export interface Skill {
  /** skill 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 向用户展示的简短描述 */
  description: string;
  /** 用于匹配用户 prompt 的关键词 */
  keywords: string[];
  /**
   * skill 分类:
   * - "tool":仅提供读取/提取能力(如 pdf-processor)
   * - "task":会产生副作用,如写文件(如 report-generator)
   * 省略时默认为 "tool"。
   */
  category?: "tool" | "task";
  /** 该 skill 激活时注入的 system prompt */
  systemPrompt: string;
  /** 该 skill 专属的附加工具 */
  tools?: Record<string, Tool>;
  /** 用于引导的建议 prompt */
  suggestions?: string[];
  /**
   * 启用回合结束后的反思门控(LLM 判定 + 扩展规则)。
   * 为 true 时,每个回合会额外付出一次廉价模型调用,
   * 用于捕捉幻觉、格式不匹配或被忽略的工具失败。
   * 默认规则(pdfParseFailure + toolDeniedSequence)始终运行,
   * 不受此项影响。对应内置 TS 导出 skill 的 SKILL.md
   * frontmatter 中的 `reflect: true` 字段。
   */
  reflect?: boolean;
}
