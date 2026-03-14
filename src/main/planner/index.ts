/**
 * Planner module — generates a structured execution plan from a user prompt.
 *
 * The plan phase uses a lightweight LLM call with read-only tools so it can
 * inspect the workspace before proposing a plan. No side effects.
 */

import { generateText, stepCountIs } from "ai";
import { skills } from "../skills";
import type { Plan, PlanStep, PlannerLLMOutput } from "./types";
import { writePlanFile } from "./plan-file";

// Re-export types for convenience
export type { Plan, PlanStep } from "./types";

/** Build the skill catalog string for the planner system prompt */
const buildSkillCatalog = (): string =>
  skills
    .map((s) => `- **${s.id}**: ${s.name} — ${s.description}`)
    .join("\n");

/**
 * Heuristic: should this prompt go through the planner?
 * Returns true for complex, multi-step tasks.
 */
/**
 * Heuristic: should this prompt go through the planner?
 * Returns true for complex, multi-step tasks.
 *
 * Design principles:
 * - Simple single-intent prompts (summarize a file, search content) → direct execution
 * - Only trigger planning when there are genuinely multiple independent actions
 * - "tool" skills (pdf-processor, xlsx-processor) provide capabilities, not separate tasks
 * - Only count "task" skills (report-generator, file-organizer) as distinct task intents
 */
export const needsPlanning = (prompt: string): boolean => {
  const lower = prompt.toLowerCase();

  // ── Fast exit: simple intent patterns should NEVER trigger planning ──
  // These are single-action requests even if they mention file types
  const simpleIntentPatterns = [
    /^(总结|概括|概述|解释|翻译|阅读|读取|查看|打开|提取|转换).{0,80}(文件|内容|文本|pdf|xlsx|docx|csv)/i,
    /^(summarize|explain|translate|read|extract|convert|open|view)\b/i,
  ];
  if (simpleIntentPatterns.some((p) => p.test(lower.trim()))) return false;

  // ── Multi-action indicators (Chinese + English) ──
  const multiActionPatterns = [
    /并且|然后|之后|接着|同时|以及|再|还要|最后/,
    /and then|after that|also|finally|next|then/i,
  ];
  if (multiActionPatterns.some((p) => p.test(lower))) return true;

  // ── Long prompts with genuine complexity ──
  // Raised threshold; length alone is a weak signal
  if (prompt.length > 300) return true;

  // ── Multiple "task" skill hits → likely multi-step ──
  // Only count skills with category "task" (those that produce side effects).
  // "tool" skills just provide read capabilities and don't constitute separate tasks.
  let taskSkillHits = 0;
  for (const skill of skills) {
    if (skill.category !== "task") continue;
    const hit = skill.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (hit) taskSkillHits++;
  }
  if (taskSkillHits >= 2) return true;

  return false;
};

/**
 * Generate a plan from a user prompt.
 *
 * Uses a single LLM call with read-only tools to inspect the workspace,
 * then outputs a structured plan as JSON.
 */
export const planTask = async (
  prompt: string,
  workspacePath: string,
  model: Parameters<typeof generateText>[0]["model"],
  readOnlyTools: Parameters<typeof generateText>[0]["tools"],
): Promise<Plan> => {
  const planId = crypto.randomUUID();
  const now = new Date().toISOString();

  const skillCatalog = buildSkillCatalog();

  const result = await generateText({
    model,
    tools: readOnlyTools,
    stopWhen: stepCountIs(10),
    system: `You are a task planner for FileWork, a local file management AI assistant.

Current workspace: ${workspacePath}

Your job is to:
1. Use the read-only tools (listDirectory, readFile, directoryStats) to understand the workspace.
2. Analyze the user's request and break it into ordered steps.
3. Output a JSON execution plan.

Available skills that can be assigned to steps:
${skillCatalog}

IMPORTANT:
- You MUST output valid JSON as the LAST part of your response, wrapped in \`\`\`json code fence.
- Each step should be a discrete, independently executable action.
- Assign a skillId only if the step clearly maps to one of the available skills.
- Keep step descriptions concise but specific.
- Order steps logically (dependencies first).

JSON schema:
\`\`\`
{
  "goal": "string — one-sentence summary of the overall goal",
  "steps": [
    {
      "action": "string — short verb label",
      "description": "string — what this step does",
      "skillId": "string | undefined — skill id if applicable"
    }
  ]
}
\`\`\``,
    prompt,
  });

  // Extract JSON from the LLM response
  const text = result.text;
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    // Fallback: try parsing the entire text as JSON
    try {
      const parsed = JSON.parse(text) as PlannerLLMOutput;
      return buildPlan(planId, prompt, workspacePath, parsed, now);
    } catch {
      // Last resort: single-step plan
      return buildPlan(planId, prompt, workspacePath, {
        goal: prompt,
        steps: [{ action: "execute", description: prompt }],
      }, now);
    }
  }

  const parsed = JSON.parse(jsonMatch[1]) as PlannerLLMOutput;
  return buildPlan(planId, prompt, workspacePath, parsed, now);
};

/** Build a Plan object from LLM output and write the plan file */
const buildPlan = async (
  planId: string,
  prompt: string,
  workspacePath: string,
  output: PlannerLLMOutput,
  now: string,
): Promise<Plan> => {
  const steps: PlanStep[] = output.steps.map((s, i) => ({
    id: i + 1,
    action: s.action,
    description: s.description,
    skillId: s.skillId,
    status: "pending",
  }));

  const plan: Plan = {
    id: planId,
    prompt,
    goal: output.goal,
    steps,
    status: "draft",
    workspacePath,
    createdAt: now,
    updatedAt: now,
  };

  // Write the plan file to disk (filesystem as memory)
  await writePlanFile(plan);

  return plan;
};
