import { ipcMain } from "electron";

import {
  type AutomationRecord,
  type AutomationRunMode,
  type AutomationRunTriageStatus,
  type AutomationScheduleKind,
  type AutomationType,
  attachAutomationRunChatSession,
  cancelAutomationRun,
  cleanupAutomationRuns,
  createAutomation,
  deleteAutomation,
  listAutomationRunEvents,
  listAutomationRuns,
  listAutomations,
  markAutomationRunHandled,
  previewAutomationSchedule,
  updateAutomation,
} from "../db";
import {
  continueAutomationRun,
  prepareAutomationChatRun,
  rerunAutomationRun,
  triggerAutomationNow,
} from "./automation-service";

type AutomationCreatePayload = {
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled?: boolean;
  threadId?: string | null;
  workspacePaths?: string[] | null;
  runMode?: AutomationRunMode | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
};

type AutomationUpdatePayload = {
  id: string;
  updates: Partial<
    Omit<AutomationRecord, "id" | "createdAt" | "updatedAt" | "nextRunAt">
  >;
};

type AutomationPreviewPayload = {
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
};

type AutomationCleanupRunsPayload = {
  olderThanDays?: number;
  triageStatus?: AutomationRunTriageStatus;
};

type AutomationPrepareChatRunPayload = {
  assistantMessageId: string;
  id: string;
  sessionId: string;
};

type AutomationAttachRunChatSessionPayload = {
  assistantMessageId?: string | null;
  id: string;
  sessionId: string;
};

const requireId = (payload: { id?: string } | null | undefined): string => {
  if (!payload?.id?.trim()) throw new Error("id is required");
  return payload.id.trim();
};

const trimOrNull = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeCreatePayload = (
  payload: AutomationCreatePayload,
): AutomationCreatePayload => {
  if (!payload?.title?.trim()) throw new Error("title is required");
  if (!payload.prompt?.trim()) throw new Error("prompt is required");
  if (!payload.type) throw new Error("type is required");
  if (!payload.scheduleKind) throw new Error("scheduleKind is required");
  if (!payload.scheduleValue?.trim())
    throw new Error("scheduleValue is required");
  const workspacePaths = payload.workspacePaths
    ?.map((path) => path.trim())
    .filter(Boolean);

  return {
    ...payload,
    title: payload.title.trim(),
    prompt: payload.prompt.trim(),
    scheduleValue: payload.scheduleValue.trim(),
    threadId: trimOrNull(payload.threadId),
    workspacePaths: workspacePaths?.length ? workspacePaths : null,
    runMode: payload.runMode ?? null,
    modelId: trimOrNull(payload.modelId),
    reasoningEffort: trimOrNull(payload.reasoningEffort),
  };
};

const normalizeUpdatePayload = (
  payload: AutomationUpdatePayload,
): AutomationUpdatePayload => {
  if (!payload?.id?.trim()) throw new Error("id is required");
  const updates = { ...payload.updates };
  if (typeof updates.title === "string") updates.title = updates.title.trim();
  if (typeof updates.prompt === "string")
    updates.prompt = updates.prompt.trim();
  if (typeof updates.scheduleValue === "string") {
    updates.scheduleValue = updates.scheduleValue.trim();
  }
  if (updates.threadId !== undefined)
    updates.threadId = trimOrNull(updates.threadId);
  if (updates.modelId !== undefined)
    updates.modelId = trimOrNull(updates.modelId);
  if (updates.reasoningEffort !== undefined) {
    updates.reasoningEffort = trimOrNull(updates.reasoningEffort);
  }
  if (updates.workspacePaths !== undefined) {
    const paths = updates.workspacePaths?.map((p) => p.trim()).filter(Boolean);
    updates.workspacePaths = paths?.length ? paths : null;
  }
  return { id: payload.id.trim(), updates };
};

export const registerAutomationsHandlers = () => {
  ipcMain.handle("automations:list", async (_event, filter?: unknown) =>
    listAutomations(filter as Parameters<typeof listAutomations>[0]),
  );

  ipcMain.handle("automations:listRuns", async (_event, filter?: unknown) =>
    listAutomationRuns(filter as Parameters<typeof listAutomationRuns>[0]),
  );

  ipcMain.handle(
    "automations:create",
    async (_event, payload: AutomationCreatePayload) =>
      createAutomation(normalizeCreatePayload(payload)),
  );

  ipcMain.handle(
    "automations:update",
    async (_event, payload: AutomationUpdatePayload) => {
      const normalized = normalizeUpdatePayload(payload);
      return updateAutomation(normalized.id, normalized.updates);
    },
  );

  ipcMain.handle(
    "automations:trigger",
    async (_event, payload: { id: string }) => {
      return triggerAutomationNow(requireId(payload));
    },
  );

  ipcMain.handle(
    "automations:prepareChatRun",
    async (_event, payload: AutomationPrepareChatRunPayload) => {
      const id = requireId(payload);
      if (!payload.sessionId?.trim()) throw new Error("sessionId is required");
      if (!payload.assistantMessageId?.trim()) {
        throw new Error("assistantMessageId is required");
      }
      return prepareAutomationChatRun(id, {
        assistantMessageId: payload.assistantMessageId.trim(),
        sessionId: payload.sessionId.trim(),
      });
    },
  );

  ipcMain.handle("automations:rerun", async (_event, payload: { id: string }) =>
    rerunAutomationRun(requireId(payload)),
  );

  ipcMain.handle(
    "automations:continueRun",
    async (_event, payload: { id: string }) =>
      continueAutomationRun(requireId(payload)),
  );

  ipcMain.handle(
    "automations:listRunEvents",
    async (_event, payload: { id: string }) =>
      listAutomationRunEvents(requireId(payload)),
  );

  ipcMain.handle(
    "automations:attachRunChatSession",
    async (_event, payload: AutomationAttachRunChatSessionPayload) => {
      const id = requireId(payload);
      if (!payload.sessionId?.trim()) throw new Error("sessionId is required");
      return attachAutomationRunChatSession(id, {
        assistantMessageId: trimOrNull(payload.assistantMessageId),
        chatSessionId: payload.sessionId.trim(),
      });
    },
  );

  ipcMain.handle(
    "automations:markRunHandled",
    async (_event, payload: { id: string }) =>
      markAutomationRunHandled(requireId(payload)),
  );

  ipcMain.handle(
    "automations:cancelRun",
    async (_event, payload: { id: string }) =>
      cancelAutomationRun(requireId(payload)),
  );

  ipcMain.handle(
    "automations:cleanupRuns",
    async (_event, payload?: AutomationCleanupRunsPayload) =>
      cleanupAutomationRuns(payload),
  );

  ipcMain.handle(
    "automations:previewSchedule",
    async (_event, payload: AutomationPreviewPayload) => {
      if (!payload?.scheduleKind) throw new Error("scheduleKind is required");
      if (!payload.scheduleValue?.trim())
        throw new Error("scheduleValue is required");
      return previewAutomationSchedule(
        payload.scheduleKind,
        payload.scheduleValue.trim(),
      );
    },
  );

  ipcMain.handle(
    "automations:delete",
    async (_event, payload: { id: string }) => {
      return deleteAutomation(requireId(payload));
    },
  );
};
