/**
 * 管理工作区目录下的 .filework/task_plan.md 文件。
 * 这是"以文件系统为记忆"层——计划文件既充当 AI 的工作记忆,
 * 也充当用户的审计日志。
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

/** 将 Plan 对象渲染为 markdown 内容 */
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

/** 获取计划文件的绝对路径 */
export const getPlanFilePath = (workspacePath: string): string =>
  join(workspacePath, PLAN_DIR, PLAN_FILE);

/** 在工作区中写入或更新计划文件 */
export const writePlanFile = async (plan: Plan): Promise<string> => {
  const dir = join(plan.workspacePath, PLAN_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = getPlanFilePath(plan.workspacePath);
  const content = renderPlanMarkdown(plan);
  await writeFile(filePath, content, "utf-8");
  return filePath;
};

/** 读取计划文件内容(用于"先读后决策"模式) */
export const readPlanFile = async (workspacePath: string): Promise<string> => {
  const filePath = getPlanFilePath(workspacePath);
  return readFile(filePath, "utf-8");
};
