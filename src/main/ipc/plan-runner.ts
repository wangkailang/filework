/**
 * Plan runner — drives an approved Plan through the AgentLoop, one step
 * at a time, streaming each step's output to the renderer over the
 * pre-existing `ai:stream-*` and `ai:plan-step-*` IPC channels.
 *
 * Replaces `src/main/planner/executor.ts`. Behavior parity:
 * - "Read Before Decide": re-reads the plan file before each step
 * - Per-step timeout (5 min default) via `createTimeoutController`
 * - Stream watchdog per step
 * - Sub-step progress emitted on each tool result (capped at totalSubSteps-1
 *   so the final sub-step only completes when the step itself succeeds)
 * - Cancellation paths: external `cancelPlan`, manual stop flag,
 *   AbortError from upstream
 * - Step failure persisted into task_plan.md with contextual error message
 *
 * The driver is now `AgentLoop` (single per-step `streamText` call wrapped
 * in retry + event translator) instead of the inline `streamText`/fullStream
 * loop that lived in planner/executor.ts.
 */

import type { LanguageModel } from "ai";
import type { WebContents } from "electron";

import { classifyError } from "../ai/error-classifier";
import {
  createTimeoutController,
  StepTimeoutError,
  StreamWatchdog,
} from "../ai/stream-watchdog";
import { AgentLoop } from "../core/agent/agent-loop";
import type { ClassifiedRetryError } from "../core/agent/retry";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import { manualStopFlags } from "../ipc/ai-task-control";
import { getSkill } from "../skills";
import { buildAgentToolRegistry } from "./agent-tools";
import { buildApprovalHook } from "./approval-hook";
import { readPlanFile, writePlanFile } from "./plan-file";
import type { Plan, PlanStepArtifact } from "./plan-types";

/** Default per-step timeout: 5 minutes */
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Truncate text to a max length, appending "..." if truncated. */
const truncateText = (text: string, max: number): string | undefined =>
  text ? (text.length > max ? `${text.slice(0, max)}...` : text) : undefined;

/**
 * Deep-truncate long string values in an object for artifact display.
 * Returns the original value if already small enough.
 */
const truncateDeep = (value: unknown, maxStringLen = 200): unknown => {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > maxStringLen
      ? `${value.slice(0, maxStringLen)}...`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateDeep(v, maxStringLen));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateDeep(v, maxStringLen);
    }
    return out;
  }
  return value;
};

interface PlanRunnerOptions {
  plan: Plan;
  model: LanguageModel;
  sender: WebContents;
  taskId: string;
  abortSignal?: AbortSignal;
}

/** Cancelled plan ids — set by the cancel handler. */
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
  sender,
  taskId,
  abortSignal,
}: PlanRunnerOptions): Promise<Plan> => {
  plan.status = "executing";
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(plan);

  const workspace = new LocalWorkspace(plan.workspacePath);

  for (const step of plan.steps) {
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
    const stepArtifacts: PlanStepArtifact[] = [];
    const pendingToolCalls = new Map<
      string,
      { toolName: string; args: Record<string, unknown> }
    >();

    const { controller: stepController, cleanup: cleanupTimeout } =
      createTimeoutController(DEFAULT_STEP_TIMEOUT_MS, abortSignal);

    try {
      // "Read Before Decide" — re-read plan file to refresh goals in context
      let planContext = "";
      try {
        planContext = await readPlanFile(plan.workspacePath);
      } catch {
        // Plan file might not exist yet on first step.
      }

      const previousResults = plan.steps
        .filter((s) => s.status === "completed" && s.resultSummary)
        .map((s) => `Step ${s.id} (${s.action}): ${s.resultSummary}`)
        .join("\n");

      const skill = step.skillId ? getSkill(step.skillId) : undefined;
      const skillPrompt = skill
        ? `\n\n## Active Skill: ${skill.name}\n${skill.systemPrompt}`
        : "";
      const skillTools = skill?.tools ?? {};

      const subStepsList = step.subSteps?.length
        ? `\n\n## Sub-tasks for this step\n${step.subSteps.map((ss, i) => `${i + 1}. ${ss.label}`).join("\n")}\nComplete each sub-task in order. After finishing each one, mention which sub-task you completed.`
        : "";

      const verificationInstruction = step.verification
        ? `\n\n## Verification\nAfter completing this step, verify: ${step.verification}`
        : "";

      const systemPrompt = `You are FileWork, executing step ${step.id}/${plan.steps.length} of a planned task.

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

      const stepPrompt = `Execute step ${step.id}: ${step.description}`;

      // Watchdog scoped to this step.
      const watchdog = new StreamWatchdog({
        taskId,
        sender,
        planId: plan.id,
        stepId: step.id,
        abortController: stepController,
      });
      watchdog.start();

      // Build a fresh ToolRegistry per step. The registry is cheap to
      // construct (just a Map) and per-step lifecycle keeps state isolated.
      const toolRegistry = buildAgentToolRegistry({
        sender,
        taskId,
        workspace,
      });
      const beforeToolCall = buildApprovalHook({ sender, taskId });
      const registryTools = toolRegistry.toAiSdkTools({
        ctxFactory: ({ toolCallId }) => ({
          workspace,
          signal: stepController.signal,
          toolCallId,
        }),
        beforeToolCall,
      });

      const agentLoop = new AgentLoop({
        workspace,
        model,
        tools: { ...registryTools, ...skillTools },
        systemPrompt,
        signal: stepController.signal,
        agentId: `${taskId}:plan-step-${step.id}`,
        maxStepsPerTurn: 15,
        classifyError: (err): ClassifiedRetryError => {
          const c = classifyError(err);
          return {
            type: c.type,
            retryable: c.retryable,
            maxRetries: c.maxRetries,
            backoffMs: c.backoffMs,
          };
        },
      });

      let manualStop = false;
      let cancelledMid = false;
      try {
        for await (const ev of agentLoop.run(stepPrompt)) {
          watchdog.activity();

          if (sender.isDestroyed()) break;

          if (manualStopFlags.get(taskId)) {
            console.log("[Plan] Manual stop flag detected for taskId:", taskId);
            manualStop = true;
            if (!stepController.signal.aborted) stepController.abort();
            // Continue draining so agent_end is observed.
          }

          if (cancelledPlans.has(plan.id)) {
            cancelledMid = true;
            if (!stepController.signal.aborted) stepController.abort();
          }

          switch (ev.type) {
            case "message_update":
              stepText += ev.deltaText;
              sender.send("ai:stream-delta", {
                id: taskId,
                delta: ev.deltaText,
              });
              break;
            case "tool_execution_start":
              sender.send("ai:stream-tool-call", {
                id: taskId,
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                args: ev.args,
              });
              pendingToolCalls.set(ev.toolCallId, {
                toolName: ev.toolName,
                args: ev.args as Record<string, unknown>,
              });
              break;
            case "tool_execution_end": {
              sender.send("ai:stream-tool-result", {
                id: taskId,
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                result: ev.result,
              });
              lastToolName = ev.toolName;

              const pending = pendingToolCalls.get(ev.toolCallId);
              if (pending) {
                stepArtifacts.push({
                  toolCallId: ev.toolCallId,
                  toolName: pending.toolName,
                  args: truncateDeep(pending.args) as Record<string, unknown>,
                  result: truncateDeep(ev.result),
                  success: ev.success,
                });
                pendingToolCalls.delete(ev.toolCallId);
              }

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
            case "agent_end":
              // Surfacing the loop's terminal status as an exception lets
              // the existing catch branch differentiate timeout / abort /
              // failure with the same logic as before.
              if (ev.status === "failed") {
                throw new Error(ev.error?.message ?? "Plan step failed");
              }
              if (ev.status === "cancelled") {
                // Convert cancellation into an AbortError so the catch
                // branch picks the user-abort path.
                const ab = new Error("aborted");
                ab.name = "AbortError";
                throw ab;
              }
              break;
          }
        }
      } finally {
        watchdog.stop();
      }

      if (cancelledMid) {
        step.status = "skipped";
        plan.status = "cancelled";
        plan.updatedAt = new Date().toISOString();
        await writePlanFile(plan);
        cancelledPlans.delete(plan.id);
        cleanupTimeout();
        return plan;
      }

      if (manualStop) {
        step.status = "completed";
        step.resultSummary = truncateText(stepText, 500) ?? "(stopped by user)";
        for (const remaining of plan.steps) {
          if (remaining.status === "pending") {
            remaining.status = "skipped";
          }
        }
        plan.status = "cancelled";
        plan.updatedAt = new Date().toISOString();
        await writePlanFile(plan);
        cleanupTimeout();
        return plan;
      }

      step.status = "completed";
      if (stepArtifacts.length > 0) {
        step.artifacts = stepArtifacts;
        if (!sender.isDestroyed()) {
          sender.send("ai:plan-step-artifacts", {
            id: taskId,
            planId: plan.id,
            stepId: step.id,
            artifacts: stepArtifacts,
          });
        }
      }
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
      step.resultSummary =
        truncateText(stepText, 500) ?? "(completed with tool calls only)";
    } catch (error: unknown) {
      const isStepTimeout =
        stepController.signal.aborted &&
        stepController.signal.reason instanceof StepTimeoutError;

      if (isStepTimeout) {
        const contextParts: string[] = [
          `步骤超时 (${DEFAULT_STEP_TIMEOUT_MS / 1000}s)，已自动跳过`,
        ];
        if (lastToolName) {
          contextParts.push(`最后执行: ${lastToolName}`);
        }
        if (stepText) {
          const partial =
            stepText.length > 150 ? `...${stepText.slice(-150)}` : stepText;
          contextParts.push(`部分输出: ${partial}`);
        }
        const timeoutMsg = contextParts.join("。");
        step.status = "skipped";
        step.error = timeoutMsg;
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

      if (error instanceof Error && error.name === "AbortError") {
        step.status = "completed";
        step.resultSummary = truncateText(stepText, 500) ?? "(aborted by user)";

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
