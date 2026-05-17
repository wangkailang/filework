import type { Tool } from "ai";

export interface Skill {
  /** Unique skill identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description shown to users */
  description: string;
  /** Keywords for matching user prompts */
  keywords: string[];
  /**
   * Skill category:
   * - "tool": provides read/extraction capabilities only (e.g. pdf-processor)
   * - "task": produces side effects like writing files (e.g. report-generator)
   * Defaults to "tool" if omitted.
   */
  category?: "tool" | "task";
  /** System prompt injected when this skill is active */
  systemPrompt: string;
  /** Additional tools specific to this skill */
  tools?: Record<string, Tool>;
  /** Suggested prompts for onboarding */
  suggestions?: string[];
  /**
   * Opt into the post-turn reflection gate (LLM verdict + extended
   * rules). When true, each turn pays one extra cheap-model call to
   * catch hallucination, format mismatch, or missed tool failures.
   * The default rules (pdfParseFailure + toolDeniedSequence) run
   * regardless. Mirrors the SKILL.md frontmatter `reflect: true` field
   * for built-in TS-export skills.
   */
  reflect?: boolean;
}
