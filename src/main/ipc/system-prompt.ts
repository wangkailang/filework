/**
 * System prompt builders for the AgentLoop.
 *
 * Two prompts live here:
 *  - `buildAgentSystemPrompt` — generic Agent prompt for ad-hoc tasks
 *    (called from `ai-handlers.ts:handleTaskExecution`)
 *  - `buildPlanStepSystemPrompt` — per-step prompt for plan execution
 *    (called from `plan-runner.ts`)
 *
 * Domain-neutral by default: the prompt does not assume a file-management
 * identity, so conceptual / analytical questions ("compare X and Y") no
 * longer get biased toward filesystem operations. When a Skill is matched
 * (explicit `/skill foo` or keyword), the skill body carries the domain
 * context (the skill itself decides what to do with files / web / shell).
 */

import type { UnifiedSkill } from "../skills-runtime/types";
import type { Plan, PlanStep } from "./plan-types";

const AGENT_IDENTITY = `You are a general-purpose AI Agent operating with full access to the user's workspace and a set of tools (read/write/list files, run shell commands, ask the user for clarification, plus any skill-specific tools).`;

const COMMON_RULES = `- Use absolute paths based on the workspace path provided.
- Be careful with destructive operations (delete, overwrite, run command); confirm scope before acting.
- Respond in the same language as the user's prompt.
- Prefer the minimum number of tool calls needed. Don't explore unless the task requires it.
- For analytical, conceptual, or research questions, answer directly — do not invent filesystem work.
- If the user's intent is genuinely ambiguous, call \`askClarification\` instead of guessing.`;

interface BuildAgentSystemPromptOptions {
  workspacePath: string;
  skill?: UnifiedSkill;
  /** Args extracted from `/skill <args>`. Empty when not an explicit skill command. */
  skillArgs?: string;
  /** True when the user typed `/skill ...` explicitly. */
  isExplicitSkillCommand?: boolean;
}

/**
 * Build the system prompt for ad-hoc (non-plan) task execution.
 *
 * When no skill matches, returns the generic agent identity + rules.
 * When a skill matches, augments with skill-specific guidance; the skill
 * body itself is prepended separately by the caller (see `ai-handlers.ts`
 * `wrapWithSecurityBoundary`).
 */
export const buildAgentSystemPrompt = ({
  workspacePath,
  skill,
  skillArgs,
  isExplicitSkillCommand,
}: BuildAgentSystemPromptOptions): string => {
  const sections: string[] = [
    AGENT_IDENTITY,
    "",
    `Current workspace: ${workspacePath}`,
    "",
    "Rules:",
    COMMON_RULES,
  ];

  if (skill) {
    if (isExplicitSkillCommand) {
      sections.push(
        "",
        `重要：用户已明确调用 ${skill.name} 技能执行任务: "${skillArgs ?? ""}"`,
        "请直接执行指定任务，不要进行不必要的环境探索或目录列举。",
      );
      if (skill.id === "agent-browser") {
        sections.push(
          "当前任务是网页相关操作，请直接使用 npx agent-browser 命令执行任务，避免使用其他文件操作工具。",
        );
      }
    }
    const allowedTools = skill.external?.frontmatter["allowed-tools"];
    if (allowedTools) {
      sections.push(
        "",
        `工具限制：当前技能仅允许使用以下工具: ${allowedTools.join(", ")}`,
      );
    }
  } else {
    // Behavioral guidelines applied only when no skill is steering the task.
    sections.push(
      "",
      "## Behavioral Guidelines",
      "",
      "### Before Acting",
      "- State your assumptions explicitly. If the user's intent is ambiguous, ask before executing.",
      "- If multiple interpretations exist, present them briefly — don't pick silently.",
      "",
      "### Surgical Precision",
      "- Only modify files directly related to the user's request.",
      '- Don\'t "improve" adjacent code, comments, or formatting.',
      "- If you notice unrelated issues, mention them — don't fix them.",
      "",
      "### Verification",
      "- After completing a task, briefly verify the result.",
      "- State what was done and what was verified.",
    );
  }

  return sections.join("\n");
};

interface SkillShape {
  name: string;
  systemPrompt?: string;
}

interface BuildPlanStepSystemPromptOptions {
  plan: Plan;
  step: PlanStep;
  /** Plan markdown re-read from disk before this step (Read Before Decide). */
  planContext: string;
  /** Concatenated summaries of completed prior steps. */
  previousResults: string;
  skill?: SkillShape;
}

/** Build the per-step system prompt for plan execution. */
export const buildPlanStepSystemPrompt = ({
  plan,
  step,
  planContext,
  previousResults,
  skill,
}: BuildPlanStepSystemPromptOptions): string => {
  const skillPrompt = skill
    ? `\n\n## Active Skill: ${skill.name}\n${skill.systemPrompt ?? ""}`
    : "";

  const subStepsList = step.subSteps?.length
    ? `\n\n## Sub-tasks for this step\n${step.subSteps.map((ss, i) => `${i + 1}. ${ss.label}`).join("\n")}\nComplete each sub-task in order. After finishing each one, mention which sub-task you completed.`
    : "";

  const verificationInstruction = step.verification
    ? `\n\n## Verification\nAfter completing this step, verify: ${step.verification}`
    : "";

  return `${AGENT_IDENTITY} You are executing step ${step.id}/${plan.steps.length} of a planned task.

Current workspace: ${plan.workspacePath}

## Current Plan (from disk)
${planContext}

## Previous Step Results
${previousResults || "(none — this is the first step)"}

## Current Step
Step ${step.id}: ${step.action} — ${step.description}${subStepsList}${verificationInstruction}

Rules:
- Focus ONLY on this step's objective. Do not do work for other steps.
- Use absolute paths based on the workspace path.
- Be concise in your response.
- Respond in the same language as the original prompt.${skillPrompt}`;
};
