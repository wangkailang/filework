/**
 * Planner module — generates a structured execution plan from a user prompt.
 *
 * The plan phase uses a lightweight LLM call with read-only tools so it can
 * inspect the workspace before proposing a plan. No side effects.
 */

import { generateText, stepCountIs } from "ai";
import { skills } from "../skills";
import { writePlanFile } from "./plan-file";
import type { Plan, PlannerLLMOutput, PlanStep, PlanSubStep } from "./types";

// Re-export types for convenience
export type { Plan, PlanStep } from "./types";

/** Build the skill catalog string for the planner system prompt */
const buildSkillCatalog = (): string =>
  skills.map((s) => `- **${s.id}**: ${s.name} — ${s.description}`).join("\n");

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
/**
 * Detect whether the prompt references files, paths, or workspace operations.
 * Used to gate planning for pure knowledge questions.
 */
const hasFileReference = (prompt: string): boolean => {
  const fileSignals = [
    /\.[a-z0-9]{2,5}\b/i,
    /\b(file|files|folder|directory|dir|path|workspace)s?\b/i,
    /文件|目录|文件夹|工作区|路径|当前目录/,
    /[/\\][\w.\-]+/,
    /\w+[/\\](?=\s|$|[一-鿿])/, // "reports/" / "docs/" 后接空格或中文
    /下的|里的|目录下/,
    /\b(this|these|that|those)\s+(doc|document|report|spreadsheet|table)/i,
    /这(个|些)?\s*(文件|文档|报告|表格|目录)/,
  ];
  return fileSignals.some((p) => p.test(prompt));
};

/**
 * Detect a pure knowledge / analytical question (compare, explain, etc.).
 * These should be answered directly without invoking the planner.
 */
const isKnowledgeQuestion = (prompt: string): boolean => {
  const trimmed = prompt.trim();
  const knowledgeStarters = [
    /^(分析|对比|比较|介绍|解释|说明|讨论|科普|阐述|论述)/,
    /^(请|帮我|帮忙|能否|可以)?\s*(分析|对比|比较|介绍|解释|说明|讨论|科普)/,
    /^(什么是|为什么|怎么样|有什么(区别|不同|差异|优势|劣势|优劣))/,
    /^(analy[sz]e|compare|contrast|explain|describe|discuss|tell me about)\b/i,
    /^(what(\s+is|'s)|why|how does|how do|difference between)/i,
  ];
  return knowledgeStarters.some((p) => p.test(trimmed));
};

export const needsPlanning = (prompt: string): boolean => {
  const lower = prompt.toLowerCase();

  // ── Fast exit: simple intent patterns should NEVER trigger planning ──
  // These are single-action requests even if they mention file types
  const simpleIntentPatterns = [
    /^(总结|概括|概述|解释|翻译|阅读|读取|查看|打开|提取|转换).{0,80}(文件|内容|文本|pdf|xlsx|docx|csv)/i,
    /^(summarize|explain|translate|read|extract|convert|open|view)\b/i,
  ];
  if (simpleIntentPatterns.some((p) => p.test(lower.trim()))) return false;

  // ── Knowledge / analytical questions without any file reference ──
  // "分析 A 和 B 的区别" / "compare A vs B" — answer directly, no plan.
  if (isKnowledgeQuestion(prompt) && !hasFileReference(prompt)) return false;

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
  abortSignal?: AbortSignal,
): Promise<Plan> => {
  const planId = crypto.randomUUID();
  const now = new Date().toISOString();

  const skillCatalog = buildSkillCatalog();

  const result = await generateText({
    model,
    tools: readOnlyTools,
    stopWhen: stepCountIs(10),
    abortSignal,
    system: `You are a task planner for FileWork, a local file management AI assistant.

Current workspace: ${workspacePath}

## Your workflow
1. First decide if the request actually needs workspace files. If it is a pure knowledge / analytical question (compare X and Y, explain a concept, "什么是…", "分析…的区别和优劣") and the user did NOT reference any local file, path, or workspace artifact, output a SINGLE-STEP plan with action "answer" and skip exploration entirely. Do NOT call listDirectory or any other tool in that case.
2. Otherwise, BRIEFLY inspect the workspace with read-only tools (listDirectory, directoryStats) — use at most 2-3 tool calls. Do NOT read file contents unless absolutely necessary for planning.
3. Analyze the user's request and break it into 3-7 ordered steps.
4. Output a JSON execution plan.

CRITICAL: You MUST output the JSON plan. Do not spend all your turns on exploration. If unsure about details, plan conservatively — the executor will discover details during execution.

## Available skills
${skillCatalog}

## Rules
- You MUST output valid JSON as the LAST part of your response, wrapped in \`\`\`json code fence.
- Break complex requests into 3-7 discrete steps. NEVER output a single step for a multi-part request.
- EXCEPTION: For pure knowledge / analytical questions with no file targets, output exactly ONE step: { "action": "answer", "description": "<short restatement of the user's question>" } — no skillId, no subSteps, no verify. The executor will answer directly without searching the workspace.
- Each step should be a discrete, independently executable action.
- Assign a skillId only if the step clearly maps to one of the available skills.
- Keep step descriptions concise but specific. Include concrete file names, paths, or targets when known.
- Order steps logically (dependencies first).
- For complex steps, add a "subSteps" array (2-5 items). Each sub-step MUST be specific and actionable:
  - BAD: "查看文件内容", "评估质量", "优化结构" (too vague)
  - GOOD: "读取 report.md 提取章节标题", "对比原文检查遗漏段落", "按时间线重组第3-5节"
  - Sub-steps should mention concrete files, data, or operations so the user knows exactly what will happen.
- Simple steps (single tool call) can omit subSteps.
- Every step SHOULD include a "verify" field: a concrete check the executor can perform to confirm the step succeeded (e.g. "listDirectory confirms files sorted into YYYY-MM subdirectories", "readFile checks report.md contains all sections").

## JSON schema
\`\`\`
{
  "goal": "string — one-sentence summary of the overall goal",
  "steps": [
    {
      "action": "string — short verb label",
      "description": "string — what this step does, mention target files/paths",
      "skillId": "string | undefined — skill id if applicable",
      "subSteps": ["读取 data.csv 提取关键指标", "生成对比图表数据"], // optional
      "verify": "string — how to confirm this step succeeded" // recommended
    }
  ]
}
\`\`\``,
    prompt,
  });

  // Extract JSON from the LLM response
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
    // Find the enclosing { before "steps"
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

  // Fallback: try to produce a reasonable multi-step plan from the prompt
  return buildFallbackPlan(prompt);
};

/**
 * When LLM fails to produce JSON, generate a reasonable plan structure
 * by analyzing the prompt for common patterns.
 */
const buildFallbackPlan = (prompt: string): PlannerLLMOutput => {
  const goal = prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt;

  // Detect common multi-part patterns and split accordingly
  const lower = prompt.toLowerCase();

  // Pattern: "总结/整理 X 并/同时/然后 生成 Y"
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

  // If no patterns matched, use a generic 3-step structure
  if (steps.length === 0) {
    steps.push(
      { action: "analyze", description: "分析任务需求，检查工作区相关文件" },
      { action: "execute", description: prompt },
      { action: "review", description: "检查执行结果，确保输出完整正确" },
    );
  }

  // Add a final review step if keyword-matched steps don't already end with one
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

  // Write the plan file to disk (filesystem as memory)
  await writePlanFile(plan);

  return plan;
};
