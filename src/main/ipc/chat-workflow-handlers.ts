/**
 * IPC handlers for chat-scoped workflow state — the brainstorming
 * HARD-GATE.
 *
 * Channel: `chat:design-decision`
 *   payload: { workflowKey: string; approved: boolean; reason?: string }
 *   returns: { ok: true }
 *
 * The renderer's DesignApprovalCard sends one of these for every
 * Approve/Reject click. Updates the in-memory state read by
 * `approval-hook.ts:buildApprovalHook` — flipping `designApproved`
 * lifts the destructive-tool block for the rest of the chat.
 *
 * Channel: `chat:get-design-state`
 *   payload: { workflowKey: string }
 *   returns: ChatWorkflowState
 *
 * Useful for renderer reconciliation after a window reload.
 */

import { ipcMain } from "electron";

import {
  type ChatWorkflowState,
  clearWorkflowState,
  getWorkflowState,
  recordDesignDecision,
} from "../state/chat-workflow-state";

interface DesignDecisionPayload {
  workflowKey: string;
  approved: boolean;
  reason?: string;
}

export const registerChatWorkflowHandlers = (): void => {
  ipcMain.handle(
    "chat:design-decision",
    async (_event, payload: DesignDecisionPayload): Promise<{ ok: true }> => {
      if (!payload?.workflowKey) {
        throw new Error("chat:design-decision payload missing workflowKey");
      }
      recordDesignDecision(payload.workflowKey, {
        approved: !!payload.approved,
        reason: payload.reason,
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "chat:get-design-state",
    async (
      _event,
      payload: { workflowKey: string },
    ): Promise<ChatWorkflowState> => {
      return getWorkflowState(payload.workflowKey);
    },
  );

  ipcMain.handle(
    "chat:clear-design-state",
    async (_event, payload: { workflowKey: string }): Promise<{ ok: true }> => {
      clearWorkflowState(payload.workflowKey);
      return { ok: true };
    },
  );
};
