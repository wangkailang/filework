/**
 * AI 计划执行处理器
 *
 * 处理与计划相关的 IPC 操作，包括计划任务的生成、
 * 审批、执行与取消。
 */

import crypto from "node:crypto";
import type { Tool } from "ai";
import { ipcMain } from "electron";
import { classifyError } from "../ai/error-classifier";
import { addTask, getDefaultLlmConfig, getLlmConfig, updateTask } from "../db";
import { getAIModelByConfigId } from "./ai-models";
import {
  abortControllers,
  cleanupTask,
  drainPlanResolver,
  markPlanApproved,
  parseInlinePlanId,
  stopTaskExecution,
} from "./ai-task-control";
import { safeTools } from "./ai-tools";
import { planTask } from "./plan-generator";
import { cancelPlan, executePlan } from "./plan-runner";
import type { Plan } from "./plan-types";

/** 等待用户审批的待处理计划 */
const pendingPlans = new Map<string, Plan>();

/**
 * 构建用于计划生成的只读工具集。
 * 仅包含不会修改文件、也不需要审批的安全工具。
 */
const buildReadOnlyTools = (): Record<string, Tool> => {
  // 计划阶段只使用安全工具 —— 不允许任何危险操作
  return {
    listDirectory: safeTools.listDirectory,
    readFile: safeTools.readFile,
    directoryStats: safeTools.directoryStats,
    // 注：runCommand 因可能产生副作用而被排除
  };
};

/**
 * 注册所有与计划相关的 IPC 处理器
 */
export const registerPlanHandlers = () => {
  /** 仅生成计划而不执行。只有当渲染层显式选择启用时才会调用
   *  （例如未来的 `/plan` 斜杠命令，或 agent 发起的计划工具调用）。
   *  不存在自动的正则门控。 */
  ipcMain.handle(
    "ai:generatePlan",
    async (
      event,
      payload: { prompt: string; workspacePath: string; llmConfigId?: string },
    ) => {
      const id = crypto.randomUUID();
      const sender = event.sender;
      const controller = new AbortController();
      abortControllers.set(id, controller);

      try {
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-start", { id });
        }

        const model = getAIModelByConfigId(payload.llmConfigId);
        // 计划生成使用只读工具以避免副作用
        const tools = buildReadOnlyTools();
        const plan = await planTask(
          payload.prompt,
          payload.workspacePath,
          model,
          tools,
          controller.signal,
        );

        // 暂存计划以备后续审批
        pendingPlans.set(plan.id, plan);

        if (!sender.isDestroyed()) {
          sender.send("ai:plan-ready", { id, plan });
          sender.send("ai:stream-done", { id });
        }

        return { id, plan };
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          if (!sender.isDestroyed()) {
            sender.send("ai:stream-done", { id });
          }
          return { id, cancelled: true };
        }

        const classified = classifyError(error);
        const errorMsg =
          classified.userMessage ||
          (error instanceof Error ? error.message : "Unknown error");
        if (!sender.isDestroyed()) {
          sender.send("ai:plan-error", { id, error: errorMsg });
          sender.send("ai:stream-error", {
            id,
            error: errorMsg,
            type: classified.type,
          });
        }
        return { id, error: errorMsg };
      } finally {
        cleanupTask(id);
      }
    },
  );

  /**
   * 执行已批准计划的共享逻辑。
   * 同时由 ai:executePlan 与 ai:approvePlan 使用。
   */
  const runApprovedPlan = async (
    event: Electron.IpcMainInvokeEvent,
    planId: string,
    llmConfigId?: string,
  ) => {
    const plan = pendingPlans.get(planId);
    if (!plan) {
      return { error: "Plan not found or already executed" };
    }

    pendingPlans.delete(planId);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sender = event.sender;

    addTask({
      id,
      workspaceId: "default",
      prompt: plan.prompt,
      status: "running",
      result: null,
      filesAffected: null,
      createdAt: now,
      completedAt: null,
    });

    const controller = new AbortController();
    abortControllers.set(id, controller);

    // 标记为计划已批准：writeFile 在工作区内跳过逐次审批
    markPlanApproved(id, plan.workspacePath);

    try {
      if (!sender.isDestroyed()) {
        sender.send("ai:stream-start", { id });
      }

      const model = getAIModelByConfigId(llmConfigId);
      const llmConfig = llmConfigId
        ? getLlmConfig(llmConfigId)
        : getDefaultLlmConfig();

      plan.status = "approved";
      const finalPlan = await executePlan({
        plan,
        model,
        sender,
        taskId: id,
        abortSignal: controller.signal,
        modelName: llmConfig?.model,
      });

      updateTask(id, {
        status: finalPlan.status === "completed" ? "completed" : "failed",
        result: finalPlan.goal,
        completedAt: new Date().toISOString(),
      });

      if (!sender.isDestroyed()) {
        sender.send("ai:stream-done", { id });
      }

      return { id, status: finalPlan.status };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        updateTask(id, {
          status: "completed",
          result: plan.goal,
          completedAt: new Date().toISOString(),
        });
        if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
        abortControllers.delete(id);
        return { id, status: "completed" };
      }
      const classified = classifyError(error);
      const errorMsg =
        classified.userMessage ||
        (error instanceof Error ? error.message : "Unknown error");
      updateTask(id, {
        status: "failed",
        result: errorMsg,
        completedAt: new Date().toISOString(),
      });
      if (!sender.isDestroyed()) {
        sender.send("ai:stream-error", {
          id,
          error: errorMsg,
          type: classified.type,
        });
      }
      return { id, status: "failed", message: errorMsg };
    } finally {
      cleanupTask(id);
    }
  };

  // 内联 `createPlan` 计划使用确定性 id `inline-<taskId>`（见
  // ai-task-control.ts 中的 makeInlinePlanId）。draft 暂停发生在
  // agent 工具的 execute() 内部 —— 此处的 approve/reject/cancel 只是
  // resolve 那个挂起的 Promise，让 AgentLoop 继续。

  /** 执行一个已批准的计划 */
  ipcMain.handle(
    "ai:executePlan",
    async (event, payload: { planId: string; llmConfigId?: string }) =>
      runApprovedPlan(event, payload.planId, payload.llmConfigId),
  );

  /** 批准一个计划（不带 llmConfigId 的 executePlan 别名） */
  ipcMain.handle(
    "ai:approvePlan",
    async (event, payload: { planId: string }) => {
      const inlineTaskId = parseInlinePlanId(payload.planId);
      if (inlineTaskId !== null) {
        drainPlanResolver(inlineTaskId, true);
        return { ok: true };
      }
      return runApprovedPlan(event, payload.planId);
    },
  );

  /** 用户拒绝了一个计划 */
  ipcMain.handle(
    "ai:rejectPlan",
    async (_event, payload: { planId: string }) => {
      const inlineTaskId = parseInlinePlanId(payload.planId);
      if (inlineTaskId !== null) {
        // 以拒绝结算挂起的工具（工具抛出 → agent loop 暴露错误），
        // 并终止任务，使任何在途工作都不再继续。
        // 若已结算，drainPlanResolver 为空操作。
        drainPlanResolver(inlineTaskId, false);
        stopTaskExecution(inlineTaskId);
        return { ok: true };
      }
      pendingPlans.delete(payload.planId);
      return { ok: true };
    },
  );

  /** 取消一个正在运行的计划 */
  ipcMain.handle(
    "ai:cancelPlan",
    async (_event, payload: { planId: string }) => {
      const inlineTaskId = parseInlinePlanId(payload.planId);
      if (inlineTaskId !== null) {
        drainPlanResolver(inlineTaskId, false);
        stopTaskExecution(inlineTaskId);
        return { ok: true };
      }
      cancelPlan(payload.planId);
      return { ok: true };
    },
  );
};
