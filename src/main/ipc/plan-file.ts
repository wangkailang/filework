/**
 * Manages the .filework/task_plan.md file in the workspace directory.
 * This is the "filesystem as memory" layer — the plan file serves as both
 * the AI's working memory and the user's audit log.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan } from "./plan-types";

const PLAN_DIR = ".filework";
const PLAN_FILE = "task_plan.md";

const statusEmoji = (s: string): string => {
  switch (s) {
    case "completed":
      return "✅";
    case "running":
      return "🔄";
    case "failed":
      return "❌";
    case "skipped":
      return "⏭️";
    default:
      return "⬜";
  }
};

/** Render a Plan object into markdown content */
const renderPlanMarkdown = (plan: Plan): string => {
  const lines: string[] = [
    `# Workspace Agent — Task Plan`,
    `> Generated: ${plan.createdAt}  `,
    `> Updated: ${plan.updatedAt}`,
    "",
    `## Goal`,
    plan.goal,
    "",
    `## Status: ${plan.status}`,
    "",
    `## Steps`,
  ];

  for (const step of plan.steps) {
    const emoji = statusEmoji(step.status);
    const skill = step.skillId ? ` _(skill: ${step.skillId})_` : "";
    lines.push(
      `${emoji} **Step ${step.id}: ${step.action}** — ${step.description}${skill}`,
    );
    if (step.subSteps?.length) {
      for (const sub of step.subSteps) {
        const subEmoji = sub.status === "done" ? "✅" : "⬜";
        lines.push(`   - ${subEmoji} ${sub.label}`);
      }
    }
    if (step.resultSummary) {
      lines.push(`   > Result: ${step.resultSummary}`);
    }
    if (step.error) {
      lines.push(`   > ❌ Error: ${step.error}`);
    }
  }

  lines.push("", `## Original Prompt`, `\`\`\``, plan.prompt, `\`\`\``, "");
  return lines.join("\n");
};

/** Get the absolute path to the plan file */
export const getPlanFilePath = (workspacePath: string): string =>
  join(workspacePath, PLAN_DIR, PLAN_FILE);

/** Write or update the plan file in the workspace */
export const writePlanFile = async (plan: Plan): Promise<string> => {
  const dir = join(plan.workspacePath, PLAN_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = getPlanFilePath(plan.workspacePath);
  const content = renderPlanMarkdown(plan);
  await writeFile(filePath, content, "utf-8");
  return filePath;
};

/** Read the plan file content (for "Read Before Decide" pattern) */
export const readPlanFile = async (workspacePath: string): Promise<string> => {
  const filePath = getPlanFilePath(workspacePath);
  return readFile(filePath, "utf-8");
};
