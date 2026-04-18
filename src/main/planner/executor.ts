/**
 * Plan executor — runs plan steps sequentially, streaming results to the renderer.
 *
 * Key patterns:
 * - "Read Before Decide": re-reads plan file before each step
 * - Error persistence: logs failures to the plan file
 * - Context passing: injects previous step summaries into each step's prompt
 */

import { stepCountIs, streamText } from "ai";
import type { WebContents } from "electron";
import {
  createTimeoutController,
  StepTimeoutError,
  StreamWatchdog,
} from "../ai/stream-watchdog";
import { manualStopFlags } from "../ipc/ai-task-control";
import { getSkill } from "../skills";
import { readPlanFile, writePlanFile } from "./plan-file";
import type { Plan } from "./types";

/** Default per-step timeout: 5 minutes */
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Truncate text to a max length, appending "..." if truncated. */
const truncateText = (text: string, max: number): string | undefined =>
  text ? (text.length > max ? `${text.slice(0, max)}...` : text) : undefined;

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
    let toolCallCount = 0;
    let lastToolName = "";
    let lastEmittedCompleted = -1;
    const totalSubSteps = step.subSteps?.length ?? 0;

    // Create per-step timeout controller before try so catch can inspect signal.reason
    const { controller: stepController, cleanup: cleanupTimeout } =
      createTimeoutController(DEFAULT_STEP_TIMEOUT_MS, abortSignal);

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

      const subStepsList = step.subSteps?.length
        ? `\n\n## Sub-tasks for this step\n${step.subSteps.map((ss, i) => `${i + 1}. ${ss.label}`).join("\n")}\nComplete each sub-task in order. After finishing each one, mention which sub-task you completed.`
        : "";

      const systemPrompt = `You are FileWork, executing step ${step.id}/${plan.steps.length} of a planned task.

Current workspace: ${plan.workspacePath}

## Current Plan (from disk)
${planContext}

## Previous Step Results
${previousResults || "(none — this is the first step)"}

## Current Step
Step ${step.id}: ${step.action} — ${step.description}${subStepsList}

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
        abortSignal: stepController.signal,
      });

      // Start watchdog for heartbeat & stall detection
      const watchdog = new StreamWatchdog({
        taskId,
        sender,
        planId: plan.id,
        stepId: step.id,
        abortController: stepController,
      });
      watchdog.start();

      try {
        // Stream step output to renderer
        for await (const part of result.fullStream) {
          watchdog.activity();

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
              lastToolName = part.toolName;
              // Track sub-step progress — cap at totalSubSteps-1 so the
              // last sub-step only completes when the step succeeds.
              // Only send IPC when the value actually changes.
              if (totalSubSteps > 0) {
                toolCallCount++;
                const completedSubSteps = Math.min(
                  toolCallCount,
                  totalSubSteps - 1,
                );
                if (completedSubSteps !== lastEmittedCompleted) {
                  lastEmittedCompleted = completedSubSteps;
                  sender.send("ai:plan-substep-progress", {
                    id: taskId,
                    planId: plan.id,
                    stepId: step.id,
                    completed: completedSubSteps,
                    total: totalSubSteps,
                  });
                }
              }
              break;
          }
        }
      } finally {
        watchdog.stop();
      }

      // Mark step completed
      step.status = "completed";
      // Mark all sub-steps as done and notify renderer
      if (step.subSteps) {
        for (const ss of step.subSteps) ss.status = "done";
        if (!sender.isDestroyed()) {
          sender.send("ai:plan-substep-progress", {
            id: taskId,
            planId: plan.id,
            stepId: step.id,
            completed: totalSubSteps,
            total: totalSubSteps,
          });
        }
      }
      // Generate a brief summary for context passing
      step.resultSummary =
        truncateText(stepText, 500) ?? "(completed with tool calls only)";
    } catch (error: unknown) {
      // Distinguish step timeout from user-initiated abort.
      // streamText wraps abort reasons as AbortError, so we check
      // the controller's signal.reason for our StepTimeoutError.
      const isStepTimeout =
        stepController.signal.aborted &&
        stepController.signal.reason instanceof StepTimeoutError;

      // Step timeout — skip and continue with remaining steps
      if (isStepTimeout) {
        // Build contextual error message
        const contextParts: string[] = [
          `步骤超时 (${DEFAULT_STEP_TIMEOUT_MS / 1000}s)，已自动跳过`,
        ];
        if (lastToolName) {
          contextParts.push(`最后执行: ${lastToolName}`);
        }
        if (stepText) {
          const partial =
            stepText.length > 150 ? `${stepText.slice(-150)}...` : stepText;
          contextParts.push(`部分输出: ${partial}`);
        }
        const timeoutMsg = contextParts.join("。");
        step.status = "skipped";
        step.error = timeoutMsg;
        // Freeze sub-step progress — don't mark remaining as done
        step.resultSummary = truncateText(stepText, 500);

        plan.updatedAt = new Date().toISOString();
        await writePlanFile(plan);

        if (!sender.isDestroyed()) {
          sender.send("ai:plan-step-error", {
            id: taskId,
            planId: plan.id,
            stepId: step.id,
            error: timeoutMsg,
          });
        }

        continue;
      }

      // User-initiated abort — mark current step done, skip remaining
      if (error instanceof Error && error.name === "AbortError") {
        step.status = "completed";
        step.resultSummary =
          stepText.length > 200
            ? `${stepText.slice(0, 200)}...`
            : stepText || "(aborted by user)";

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

      // Other errors — stop execution
      const rawError = error instanceof Error ? error.message : "Unknown error";
      const errorContext = lastToolName
        ? `${rawError} (执行 ${lastToolName} 时出错)`
        : rawError;
      step.status = "failed";
      step.error = errorContext;
      step.resultSummary = truncateText(stepText, 500);

      plan.updatedAt = new Date().toISOString();
      await writePlanFile(plan);

      if (!sender.isDestroyed()) {
        sender.send("ai:plan-step-error", {
          id: taskId,
          planId: plan.id,
          stepId: step.id,
          error: errorContext,
        });
      }

      plan.status = "failed";
      plan.updatedAt = new Date().toISOString();
      await writePlanFile(plan);
      return plan;
    } finally {
      cleanupTimeout();
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
