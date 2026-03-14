/**
 * Plan executor — runs plan steps sequentially, streaming results to the renderer.
 *
 * Key patterns:
 * - "Read Before Decide": re-reads plan file before each step
 * - Error persistence: logs failures to the plan file
 * - Context passing: injects previous step summaries into each step's prompt
 */

import { streamText, stepCountIs } from "ai";
import type { WebContents } from "electron";
import { getSkill } from "../skills";
import type { Plan, PlanStep } from "./types";
import { readPlanFile, writePlanFile } from "./plan-file";
import { abortControllers, manualStopFlags } from "../ipc/ai-handlers";

interface ExecutorOptions {
  plan: Plan;
  model: Parameters<typeof streamText>[0]["model"];
  tools: Parameters<typeof streamText>[0]["tools"];
  sender: WebContents;
  taskId: string;
  abortSignal?: AbortSignal;
}

/** Cancelled plan ids — set by the cancel handler */
const cancelledPlans = new Set<string>();

export const cancelPlan = (planId: string): void => {
  cancelledPlans.add(planId);
};

/**
 * Execute a plan step by step, streaming each step's output to the renderer.
 * Returns the final updated plan.
 */
export const executePlan = async ({
  plan,
  model,
  tools,
  sender,
  taskId,
  abortSignal,
}: ExecutorOptions): Promise<Plan> => {
  plan.status = "executing";
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(plan);

  for (const step of plan.steps) {
    // Check cancellation
    if (cancelledPlans.has(plan.id)) {
      step.status = "skipped";
      plan.status = "cancelled";
      plan.updatedAt = new Date().toISOString();
      await writePlanFile(plan);
      cancelledPlans.delete(plan.id);
      break;
    }

    step.status = "running";
    plan.updatedAt = new Date().toISOString();
    await writePlanFile(plan);

    // Notify renderer of step progress
    if (!sender.isDestroyed()) {
      sender.send("ai:plan-step-start", {
        id: taskId,
        planId: plan.id,
        stepId: step.id,
        totalSteps: plan.steps.length,
      });
    }

    let stepText = "";
    try {
      // "Read Before Decide" — re-read plan file to refresh goals in context
      let planContext = "";
      try {
        planContext = await readPlanFile(plan.workspacePath);
      } catch {
        // Plan file might not exist yet on first step, that's ok
      }

      // Build context from previous completed steps
      const previousResults = plan.steps
        .filter((s) => s.status === "completed" && s.resultSummary)
        .map((s) => `Step ${s.id} (${s.action}): ${s.resultSummary}`)
        .join("\n");

      // Get skill-specific system prompt and tools
      const skill = step.skillId ? getSkill(step.skillId) : undefined;
      const skillPrompt = skill
        ? `\n\n## Active Skill: ${skill.name}\n${skill.systemPrompt}`
        : "";
      const skillTools = skill?.tools ?? {};

      const systemPrompt = `You are FileWork, executing step ${step.id}/${plan.steps.length} of a planned task.

Current workspace: ${plan.workspacePath}

## Current Plan (from disk)
${planContext}

## Previous Step Results
${previousResults || "(none — this is the first step)"}

## Current Step
Step ${step.id}: ${step.action} — ${step.description}

Rules:
- Focus ONLY on this step's objective. Do not do work for other steps.
- Use absolute paths based on the workspace path.
- Be concise in your response.
- Respond in the same language as the original prompt.${skillPrompt}`;

      const stepPrompt = `Execute step ${step.id}: ${step.description}`;

      const result = streamText({
        model,
        tools: { ...tools, ...skillTools },
        stopWhen: stepCountIs(15),
        system: systemPrompt,
        prompt: stepPrompt,
        abortSignal,
      });

      // Stream step output to renderer
      for await (const part of result.fullStream) {
        if (sender.isDestroyed()) break;

        // Check manual stop flag
        if (manualStopFlags.get(taskId)) {
          console.log("[Plan] Manual stop flag detected for taskId:", taskId);
          break;
        }

        // Check cancellation mid-stream
        if (cancelledPlans.has(plan.id)) {
          break;
        }

        switch (part.type) {
          case "text-delta":
            stepText += part.text;
            sender.send("ai:stream-delta", { id: taskId, delta: part.text });
            break;
          case "tool-call":
            sender.send("ai:stream-tool-call", {
              id: taskId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.input,
            });
            break;
          case "tool-result":
            sender.send("ai:stream-tool-result", {
              id: taskId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: part.output,
            });
            break;
        }
      }

      // Mark step completed
      step.status = "completed";
      // Generate a brief summary (first 200 chars of output)
      step.resultSummary = stepText.length > 200
        ? stepText.slice(0, 200) + "..."
        : stepText || "(completed with tool calls only)";

    } catch (error: unknown) {
      // Handle user-initiated abort — current step completed, remaining skipped
      if (error instanceof Error && error.name === "AbortError") {
        step.status = "completed";
        step.resultSummary = stepText.length > 200
          ? stepText.slice(0, 200) + "..."
          : stepText || "(aborted by user)";

        // Mark remaining steps as skipped
        for (const remaining of plan.steps) {
          if (remaining.status === "pending") {
            remaining.status = "skipped";
          }
        }

        plan.status = "cancelled";
        plan.updatedAt = new Date().toISOString();
        await writePlanFile(plan);
        return plan;
      }

      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      step.status = "failed";
      step.error = errorMsg;

      // Error persistence — write failure to plan file
      plan.updatedAt = new Date().toISOString();
      await writePlanFile(plan);

      // Notify renderer of step failure
      if (!sender.isDestroyed()) {
        sender.send("ai:plan-step-error", {
          id: taskId,
          planId: plan.id,
          stepId: step.id,
          error: errorMsg,
        });
      }

      // Stop execution on failure — user can decide to retry or skip
      plan.status = "failed";
      plan.updatedAt = new Date().toISOString();
      await writePlanFile(plan);
      return plan;
    }

    plan.updatedAt = new Date().toISOString();
    await writePlanFile(plan);

    // Notify renderer of step completion
    if (!sender.isDestroyed()) {
      sender.send("ai:plan-step-done", {
        id: taskId,
        planId: plan.id,
        stepId: step.id,
      });
    }
  }

  if (plan.status === "executing") {
    plan.status = "completed";
    plan.updatedAt = new Date().toISOString();
    await writePlanFile(plan);
  }

  return plan;
};
