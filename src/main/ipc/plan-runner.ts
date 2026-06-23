/**
 * 计划执行器——驱动已批准的 Plan 逐步通过 AgentLoop 执行,
 * 并通过既有的 `ai:stream-*` 和 `ai:plan-step-*` IPC 通道
 * 将每一步的输出流式发送给渲染进程。
 *
 * 取代 `src/main/planner/executor.ts`。行为对齐:
 * - "先读后决策":每步执行前重新读取计划文件
 * - 通过 `createTimeoutController` 实现单步超时(默认 5 分钟)
 * - 每步配备流式看门狗(stream watchdog)
 * - 每次工具结果触发子步骤进度上报(上限为 totalSubSteps-1,
 *   以便最后一个子步骤只在该步骤本身成功时才完成)
 * - 取消路径:外部 `cancelPlan`、手动停止标志、上游抛出的 AbortError
 * - 步骤失败时连同上下文错误信息一并持久化到 task_plan.md
 *
 * 现在的驱动器是 `AgentLoop`(单步一次 `streamText` 调用,外层包裹
 * 重试 + 事件转译),而非此前 planner/executor.ts 中内联的
 * `streamText`/fullStream 循环。
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
import { consumePreview } from "../core/agent/preview/snapshot-store";
import type { ClassifiedRetryError } from "../core/agent/retry";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import { isGitBackedWorkspace } from "../core/workspace/workspace-factory";
import { readWorkspaceMemory } from "../core/workspace/workspace-memory";
import { manualStopFlags } from "../ipc/ai-task-control";
import { getSkill } from "../skills";
import { buildAgentToolRegistry } from "./agent-tools";
import { buildApprovalHook } from "./approval-hook";
import { readPlanFile, writePlanFile } from "./plan-file";
import type { Plan, PlanStepArtifact } from "./plan-types";
import { buildPlanStepSystemPrompt } from "./system-prompt";

/** 默认单步超时:5 分钟 */
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** 将文本截断到最大长度,被截断时追加 "..."。 */
const truncateText = (text: string, max: number): string | undefined =>
  text ? (text.length > max ? `${text.slice(0, max)}...` : text) : undefined;

/**
 * 深度截断对象中的长字符串值,用于产物(artifact)展示。
 * 若已足够小则原样返回。
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
  /** 解析后的 LLM 标识;会出现在提交信息的 Co-Authored-By 尾注中。 */
  modelName?: string;
}

/** 已取消的计划 id——由取消处理器写入。 */
const cancelledPlans = new Set<string>();

export const cancelPlan = (planId: string): void => {
  cancelledPlans.add(planId);
};

/**
 * 逐步执行计划,并将每一步的输出流式发送给渲染进程。
 * 返回最终更新后的计划。
 */
export const executePlan = async ({
  plan,
  model,
  sender,
  taskId,
  abortSignal,
  modelName,
}: PlanRunnerOptions): Promise<Plan> => {
  plan.status = "executing";
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(plan);

  const workspace = new LocalWorkspace(plan.workspacePath);
  const isGitWorkspace = isGitBackedWorkspace(workspace);

  // 计划执行同样注入工作目录记忆（AGENTS.md / CLAUDE.md），各步骤复用同一份。
  const workspaceMemory = await readWorkspaceMemory(workspace);

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
      // "先读后决策"——重新读取计划文件,刷新上下文中的目标
      let planContext = "";
      try {
        planContext = await readPlanFile(plan.workspacePath);
      } catch {
        // 首步执行时计划文件可能尚不存在。
      }

      const previousResults = plan.steps
        .filter((s) => s.status === "completed" && s.resultSummary)
        .map((s) => `Step ${s.id} (${s.action}): ${s.resultSummary}`)
        .join("\n");

      const skill = step.skillId ? getSkill(step.skillId) : undefined;
      const skillTools = skill?.tools ?? {};

      const systemPrompt = buildPlanStepSystemPrompt({
        plan,
        step,
        planContext,
        previousResults,
        skill,
        modelName,
        isGitWorkspace,
        workspaceMemory,
      });

      const stepPrompt = `Execute step ${step.id}: ${step.description}`;

      // 作用域限定于本步骤的看门狗。
      const watchdog = new StreamWatchdog({
        taskId,
        sender,
        planId: plan.id,
        stepId: step.id,
        abortController: stepController,
      });
      watchdog.start();

      // 每步构建一个全新的 ToolRegistry。该注册表构造开销很低(只是一个 Map),
      // 且按步骤的生命周期能让状态保持隔离。
      const toolRegistry = buildAgentToolRegistry({
        sender,
        taskId,
        modelName,
        isGitWorkspace,
      });
      const beforeToolCall = buildApprovalHook({
        sender,
        taskId,
        workspace,
      });
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
            userMessage: c.userMessage,
            recoveryActions: c.recoveryActions,
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
            // 继续消费流,以便能观察到 agent_end。
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
            case "tool_execution_start": {
              const previewSnapshot = consumePreview(ev.toolCallId);
              sender.send("ai:stream-tool-call", {
                id: taskId,
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                args: ev.args,
                previewSnapshot,
              });
              pendingToolCalls.set(ev.toolCallId, {
                toolName: ev.toolName,
                args: ev.args as Record<string, unknown>,
              });
              break;
            }
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
              // 把循环的终止状态以异常形式抛出,可让既有的 catch 分支
              // 沿用与此前相同的逻辑来区分超时 / 中止 / 失败。
              if (ev.status === "failed") {
                throw new Error(ev.error?.message ?? "Plan step failed");
              }
              if (ev.status === "cancelled") {
                // 将取消转换为 AbortError,使 catch 分支走用户中止路径。
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
