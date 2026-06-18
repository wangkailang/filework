import { ipcMain } from "electron";

import {
  type AutomationRecord,
  type AutomationRunMode,
  type AutomationScheduleKind,
  type AutomationType,
  createAutomation,
  deleteAutomation,
  listAutomations,
  triggerAutomation,
  updateAutomation,
} from "../db";

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

  return {
    ...payload,
    title: payload.title.trim(),
    prompt: payload.prompt.trim(),
    scheduleValue: payload.scheduleValue.trim(),
    threadId: trimOrNull(payload.threadId),
    workspacePaths: payload.workspacePaths?.map((p) => p.trim()).filter(Boolean)
      .length
      ? payload.workspacePaths.map((p) => p.trim()).filter(Boolean)
      : null,
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
      if (!payload?.id?.trim()) throw new Error("id is required");
      return triggerAutomation(payload.id.trim());
    },
  );

  ipcMain.handle(
    "automations:delete",
    async (_event, payload: { id: string }) => {
      if (!payload?.id?.trim()) throw new Error("id is required");
      return deleteAutomation(payload.id.trim());
    },
  );
};
