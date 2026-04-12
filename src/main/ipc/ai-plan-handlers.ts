/**
 * AI Plan Execution Handlers
 *
 * Handles plan-related IPC operations including generation,
 * approval, execution, and cancellation of planned tasks.
 */

import { ipcMain } from "electron";
import crypto from "node:crypto";
import type { Tool } from "ai";
import { addTask, updateTask } from "../db";
import { needsPlanning, planTask } from "../planner";
import { executePlan, cancelPlan } from "../planner/executor";
import type { Plan } from "../planner/types";
import { getAIModelByConfigId, isAuthError } from "./ai-models";
import { buildTools } from "./ai-tool-permissions";
import { abortControllers, cleanupTask } from "./ai-task-control";
import { safeTools } from "./ai-tools";

/** Pending plans waiting for user approval */
const pendingPlans = new Map<string, Plan>();

/**
 * Build a read-only tool set for plan generation.
 * Only includes safe tools that don't modify files or require approval.
 */
const buildReadOnlyTools = (): Record<string, Tool> => {
  // Only use safe tools for planning - no dangerous operations allowed
  return {
    listDirectory: safeTools.listDirectory,
    readFile: safeTools.readFile,
    directoryStats: safeTools.directoryStats,
    // Note: runCommand is excluded as it could have side effects
  };
};

/**
 * Register all plan-related IPC handlers
 */
export const registerPlanHandlers = () => {
  /** Check if a prompt needs planning (used by renderer to decide UI flow) */
  ipcMain.handle(
    "ai:checkNeedsPlanning",
    async (_event, payload: { prompt: string }) => {
      return { needsPlanning: needsPlanning(payload.prompt) };
    },
  );

  /** Generate a plan without executing it */
  ipcMain.handle(
    "ai:generatePlan",
    async (event, payload: { prompt: string; workspacePath: string; llmConfigId?: string }) => {
      try {
        const model = getAIModelByConfigId(payload.llmConfigId);
        // Use read-only tools for plan generation to avoid side effects
        const tools = buildReadOnlyTools();
        const plan = await planTask(payload.prompt, payload.workspacePath, model, tools);

        // Store plan for later approval
        pendingPlans.set(plan.id, plan);

        return { plan };
      } catch (error: unknown) {
        const errorMsg = isAuthError(error)
          ? "API Key 无效或已过期，请在设置中检查该渠道配置"
          : error instanceof Error ? error.message : "Unknown error";
        return { error: errorMsg };
      }
    },
  );

  /** Execute an approved plan */
  ipcMain.handle(
    "ai:executePlan",
    async (event, payload: { planId: string; llmConfigId?: string }) => {
      const plan = pendingPlans.get(payload.planId);
      if (!plan) {
        return { error: "Plan not found or already executed" };
      }

      // Remove from pending plans
      pendingPlans.delete(payload.planId);

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

      // Create AbortController for this plan execution
      const controller = new AbortController();
      console.log("[Main] Created AbortController for plan taskId:", id);
      abortControllers.set(id, controller);

      try {
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-start", { id });
        }

        const model = getAIModelByConfigId(payload.llmConfigId);
        const tools = buildTools(sender, id);

        plan.status = "approved";
        const finalPlan = await executePlan({
          plan,
          model,
          tools,
          sender,
          taskId: id,
          abortSignal: controller.signal,
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
          // User-initiated abort — treat as normal completion
          console.log("[Main] Plan AbortError caught, cleaning up for taskId:", id);
          updateTask(id, { status: "completed", result: plan.goal, completedAt: new Date().toISOString() });
          if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
          // Clean up AbortController immediately
          abortControllers.delete(id);
          return { id, status: "completed" };
        }
        const errorMsg = isAuthError(error)
          ? "API Key 无效或已过期，请在设置中检查该渠道配置"
          : error instanceof Error ? error.message : "Unknown error";
        updateTask(id, {
          status: "failed",
          result: errorMsg,
          completedAt: new Date().toISOString(),
        });
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-error", { id, error: errorMsg });
        }
        return { id, status: "failed", message: errorMsg };
      } finally {
        cleanupTask(id);
      }
    },
  );

  /** User rejected a plan */
  ipcMain.handle(
    "ai:rejectPlan",
    async (_event, payload: { planId: string }) => {
      pendingPlans.delete(payload.planId);
      return { ok: true };
    },
  );

  /** Cancel a running plan */
  ipcMain.handle(
    "ai:cancelPlan",
    async (_event, payload: { planId: string }) => {
      cancelPlan(payload.planId);
      return { ok: true };
    },
  );
};