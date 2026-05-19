/**
 * Plan generator — turns a user prompt into a structured Plan.
 *
 * Lives in the IPC layer (not core/) because:
 * - It uses a separate `generateText` call with a read-only tool subset,
 *   not the AgentLoop turn-stream
 * - Its 4-strategy JSON-extraction fallback is tuned for filework's model
 *   population (DeepSeek + custom OpenAI-compatible endpoints) and is not
 *   a domain-neutral concern
 *
 * Replaces `src/main/planner/index.ts` (logic preserved verbatim).
 */

import crypto from "node:crypto";
import { generateText, stepCountIs } from "ai";
import { skills } from "../skills";
import { writePlanFile } from "./plan-file";
import type {
  Plan,
  PlannerLLMOutput,
  PlanStep,
  PlanSubStep,
} from "./plan-types";
import { formatCurrentDate, formatLocaleContext } from "./system-prompt";

// Re-export types for convenience for callers that previously imported via
// the old `../planner` barrel.
export type { Plan, PlanStep } from "./plan-types";

/** Format one skill as a catalog bullet */
const formatSkillEntry = (s: (typeof skills)[number]): string =>
  `- **${s.id}**: ${s.name} — ${s.description}`;

/**
 * Build a skill catalog filtered by relevance to the user's prompt.
 *
 * Why filter: the catalog is injected into the planner system prompt
 * every call. As the skill set grows, an all-skills catalog dilutes
 * the prompt with mostly-irrelevant entries.
 *
 * Matching rule: case-insensitive keyword hit on the prompt. We
 * always include all "task"-category skills (they produce side
 * effects, so the planner must be able to assign them as step
 * skillIds regardless of prompt wording).
 *
 * Safety net: if fewer than `MIN_CATALOG_SIZE` skills match, fall
 * back to the full catalog. Avoids starving the planner when the
 * prompt is short or uses synonyms we don't index.
 */
const MIN_CATALOG_SIZE = 3;

export const buildRelevantSkillCatalog = (prompt: string): string => {
  const lower = prompt.toLowerCase();
  const matched: Array<(typeof skills)[number]> = [];

  for (const s of skills) {
    const isTask = s.category === "task";
    const keywordHit = s.keywords.some((kw) =>
      lower.includes(kw.toLowerCase()),
    );
    if (isTask || keywordHit) {
      matched.push(s);
    }
  }

  if (matched.length < MIN_CATALOG_SIZE) {
    return skills.map(formatSkillEntry).join("\n");
  }
  return matched.map(formatSkillEntry).join("\n");
};

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
  if (prompt.length > 300) return true;

  // ── Single-deliverable fast-exit ──
  // "生成/导出 X" 型请求在长度可控、不含多动作连接词时视为单意图。
  // 即使关键词同时命中多个 task skill（如 report-generator + data-processor），
  // 也应直接执行而非进入 plan 流程。
  const singleDeliverablePatterns = [
    /^(帮我|请|麻烦)?\s*(生成|创建|制作|导出|输出|写|做)/,
    /^(please\s+)?(generate|create|make|export|output|write|build|produce)\b/i,
  ];
  if (
    prompt.length < 150 &&
    singleDeliverablePatterns.some((p) => p.test(prompt.trim()))
  ) {
    return false;
  }

  // ── Multiple "task" skill hits → likely multi-step ──
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
  abortSignal?: AbortSignal,
): Promise<Plan> => {
  const planId = crypto.randomUUID();
  const now = new Date().toISOString();

  const skillCatalog = buildRelevantSkillCatalog(prompt);

  const result = await generateText({
    model,
    tools: readOnlyTools,
    stopWhen: stepCountIs(10),
    abortSignal,
    system: `You are a task planner. Inspect the workspace briefly (≤3 read-only tool calls — listDirectory, directoryStats; avoid reading file contents), then output a JSON plan.

Current date: ${formatCurrentDate()}
User locale: ${formatLocaleContext()}
Workspace: ${workspacePath}

## Available skills
${skillCatalog}

## How to plan
Break the request into 3-7 ordered steps. Each step is a discrete, independently executable action with concrete file/path targets when known. Order by dependency. Assign a skillId only when a step clearly maps to one of the skills above. For each step, define how the executor will verify success — the \`verify\` field is the success criterion. For complex steps, decompose into 2-5 specific subSteps that mention concrete files, data, or operations.

## Output
Wrap a JSON object in a \`\`\`json fence as the last part of your response:

\`\`\`
{
  "goal": "one-sentence summary of the overall goal",
  "steps": [
    {
      "action": "short verb label",
      "description": "what this step does; mention target files/paths",
      "skillId": "skill id if applicable",
      "subSteps": ["concrete sub-task 1", "concrete sub-task 2"],
      "verify": "how to confirm this step succeeded"
    }
  ]
}
\`\`\``,
    prompt,
  });

  const text = result.text;
  const parsed = extractPlanJson(text, prompt);
  return buildPlan(planId, prompt, workspacePath, parsed, now);
};

/** Validate that a parsed object has the expected PlannerLLMOutput shape */
const isValidPlanOutput = (obj: unknown): obj is PlannerLLMOutput => {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.goal !== "string" || o.goal.trim() === "") return false;
  if (!Array.isArray(o.steps) || o.steps.length === 0) return false;
  return (o.steps as unknown[]).every((s) => {
    if (typeof s !== "object" || s === null) return false;
    const step = s as Record<string, unknown>;
    if (typeof step.action !== "string" || step.action.trim() === "")
      return false;
    if (typeof step.description !== "string" || step.description.trim() === "")
      return false;
    if ("subSteps" in step && !Array.isArray(step.subSteps)) return false;
    return true;
  });
};

/** Try to parse JSON and validate its shape. Returns null on failure. */
const tryParsePlan = (json: string): PlannerLLMOutput | null => {
  try {
    const parsed = JSON.parse(json);
    if (isValidPlanOutput(parsed)) return parsed;
    console.warn(
      "[Planner] JSON parsed but invalid shape:",
      Object.keys(parsed),
    );
    return null;
  } catch {
    return null;
  }
};

/**
 * Try multiple strategies to extract plan JSON from LLM output.
 * Falls back to a structured multi-step plan (never a raw prompt dump).
 */
const extractPlanJson = (text: string, prompt: string): PlannerLLMOutput => {
  // Strategy 1: ```json ... ``` fence
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const result = tryParsePlan(fenceMatch[1]);
    if (result) return result;
    console.warn("[Planner] JSON fence found but parse/validation failed");
  }

  // Strategy 2: ``` ... ``` fence (no language tag)
  const bareMatch = text.match(/```\s*([\s\S]*?)```/);
  if (bareMatch) {
    const result = tryParsePlan(bareMatch[1]);
    if (result) return result;
    console.warn("[Planner] Bare fence found but parse/validation failed");
  }

  // Strategy 3: find JSON object containing "steps" array
  const stepsIdx = text.indexOf('"steps"');
  if (stepsIdx !== -1) {
    const braceStart = text.lastIndexOf("{", stepsIdx);
    const braceEnd = text.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > stepsIdx) {
      const result = tryParsePlan(text.slice(braceStart, braceEnd + 1));
      if (result) return result;
      console.warn(
        "[Planner] Brace extraction found but parse/validation failed",
      );
    }
  }

  // Strategy 4: entire text as JSON
  if (text.trim()) {
    const result = tryParsePlan(text);
    if (result) return result;
    console.warn(
      "[Planner] All JSON extraction strategies failed. Text length:",
      text.length,
      "Preview:",
      text.slice(0, 200),
    );
  } else {
    console.warn(
      "[Planner] LLM returned no text — likely exhausted tool call steps",
    );
  }

  return buildFallbackPlan(prompt);
};

/**
 * When LLM fails to produce JSON, generate a reasonable plan structure
 * by analyzing the prompt for common patterns.
 */
const buildFallbackPlan = (prompt: string): PlannerLLMOutput => {
  const goal = prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt;

  const lower = prompt.toLowerCase();

  const hasGenerate = /生成|创建|制作|输出|写|create|generate|make|write/i.test(
    lower,
  );
  const hasSummarize = /总结|整理|概括|分析|summarize|organize|analyze/i.test(
    lower,
  );
  const hasUrl = /https?:\/\/\S+/.test(prompt);

  const steps: PlannerLLMOutput["steps"] = [];

  if (hasUrl) {
    steps.push({
      action: "fetch",
      description: "获取并解析 URL 内容",
      subSteps: ["访问目标链接", "提取正文内容", "识别关键信息"],
    });
  }

  if (hasSummarize) {
    steps.push({
      action: "summarize",
      description: "分析内容并整理成结构化文档",
      subSteps: ["提取核心观点", "组织文档结构", "生成 Markdown 文件"],
    });
  }

  if (hasGenerate && /ppt|幻灯片|slide|presentation/i.test(lower)) {
    steps.push({
      action: "generate-ppt",
      description: "基于整理内容生成 PPT",
      subSteps: ["规划 PPT 结构和页面", "编写各页内容", "创建 PPT 文件"],
    });
  } else if (hasGenerate) {
    steps.push({
      action: "generate",
      description: "生成目标文件",
    });
  }

  if (steps.length === 0) {
    steps.push(
      { action: "analyze", description: "分析任务需求，检查工作区相关文件" },
      { action: "execute", description: prompt },
      { action: "review", description: "检查执行结果，确保输出完整正确" },
    );
  }

  const lastAction = steps[steps.length - 1].action;
  if (steps.length > 1 && lastAction !== "review") {
    steps.push({
      action: "review",
      description: "检查生成的文件，确保内容完整且格式正确",
    });
  }

  return { goal, steps };
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
    verification: s.verify,
    subSteps: s.subSteps?.map(
      (label): PlanSubStep => ({ label, status: "pending" }),
    ),
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

  await writePlanFile(plan);

  return plan;
};
