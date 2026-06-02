/**
 * 计划生成器——把用户提示词转换为结构化的 Plan。
 *
 * 之所以放在 IPC 层(而非 core/),原因是:
 * - 它使用一个独立的 `generateText` 调用配合只读工具子集,
 *   而非 AgentLoop 的轮次流(turn-stream)
 * - 它的 4 种策略 JSON 提取兜底逻辑是针对 filework 的模型群体
 *   (DeepSeek + 自定义 OpenAI 兼容端点)调优的,并非领域中立的关注点
 *
 * 取代 `src/main/planner/index.ts`(逻辑逐字保留)。
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

// 重新导出类型,方便此前通过旧的 `../planner` barrel 导入的调用方。
export type { Plan, PlanStep } from "./plan-types";

/** 将单个 skill 格式化为目录中的一个条目 */
const formatSkillEntry = (s: (typeof skills)[number]): string =>
  `- **${s.id}**: ${s.name} — ${s.description}`;

/**
 * 构建一份按与用户提示词相关性过滤后的 skill 目录。
 *
 * 为何过滤:该目录每次调用都会注入到规划器的系统提示中。随着 skill 集合增长,
 * 全量 skill 目录会用大量无关条目稀释提示。
 *
 * 匹配规则:对提示词做大小写不敏感的关键词命中。我们始终包含所有
 * "task" 类别的 skill(它们会产生副作用,因此无论提示词措辞如何,
 * 规划器都必须能把它们指派为某步骤的 skillId)。
 *
 * 兜底机制:若匹配到的 skill 少于 `MIN_CATALOG_SIZE`,则回退到完整目录。
 * 避免在提示词很短或使用了我们未索引的同义词时让规划器无可用 skill。
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
 * 根据用户提示词生成一份计划。
 *
 * 使用单次 LLM 调用配合只读工具来检查工作区,
 * 然后以 JSON 形式输出结构化计划。
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

/** 校验解析得到的对象是否符合预期的 PlannerLLMOutput 结构 */
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

/** 尝试解析 JSON 并校验其结构。失败时返回 null。 */
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
 * 尝试多种策略从 LLM 输出中提取计划 JSON。
 * 失败时回退到结构化的多步骤计划(绝不直接堆砌原始提示词)。
 */
const extractPlanJson = (text: string, prompt: string): PlannerLLMOutput => {
  // 策略 1:```json ... ``` 代码围栏
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const result = tryParsePlan(fenceMatch[1]);
    if (result) return result;
    console.warn("[Planner] JSON fence found but parse/validation failed");
  }

  // 策略 2:``` ... ``` 代码围栏(无语言标记)
  const bareMatch = text.match(/```\s*([\s\S]*?)```/);
  if (bareMatch) {
    const result = tryParsePlan(bareMatch[1]);
    if (result) return result;
    console.warn("[Planner] Bare fence found but parse/validation failed");
  }

  // 策略 3:查找包含 "steps" 数组的 JSON 对象
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

  // 策略 4:将整段文本作为 JSON 解析
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
 * 当 LLM 未能产出 JSON 时,通过分析提示词中的常见模式
 * 生成一份合理的计划结构。
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

/** 根据 LLM 输出构建 Plan 对象并写入计划文件 */
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
