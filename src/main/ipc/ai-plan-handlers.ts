/**
 * AI Plan Execution Handlers
 *
 * Handles plan-related IPC operations including generation,
 * approval, execution, and cancellation of planned tasks.
 */

import crypto from "node:crypto";
import type { Tool } from "ai";
import { ipcMain } from "electron";
import { classifyError } from "../ai/error-classifier";
import { addTask, updateTask } from "../db";
import { needsPlanning, planTask } from "../planner";
import { cancelPlan, executePlan } from "../planner/executor";
import type { Plan } from "../planner/types";
import { getAIModelByConfigId } from "./ai-models";
import {
  abortControllers,
  cleanupTask,
  markPlanApproved,
} from "./ai-task-control";

import { buildTools } from "./ai-tool-permissions";
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
        // Use read-only tools for plan generation to avoid side effects
        const tools = buildReadOnlyTools();
        const plan = await planTask(
          payload.prompt,
          payload.workspacePath,
          model,
          tools,
          controller.signal,
        );

        // Store plan for later approval
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
   * Shared logic for executing an approved plan.
   * Used by both ai:executePlan and ai:approvePlan.
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

    // Mark as plan-approved: writeFile skips individual approval within workspace
    markPlanApproved(id, plan.workspacePath);

    try {
      if (!sender.isDestroyed()) {
        sender.send("ai:stream-start", { id });
      }

      const model = getAIModelByConfigId(llmConfigId);
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

  /** Execute an approved plan */
  ipcMain.handle(
    "ai:executePlan",
    async (event, payload: { planId: string; llmConfigId?: string }) =>
      runApprovedPlan(event, payload.planId, payload.llmConfigId),
  );

  /** Approve a plan (alias for executePlan without llmConfigId) */
  ipcMain.handle("ai:approvePlan", async (event, payload: { planId: string }) =>
    runApprovedPlan(event, payload.planId),
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
