import { z } from "zod/v4";
import {
  type AutomationRunMode,
  type AutomationScheduleKind,
  type AutomationType,
  createAutomation,
  deleteAutomation,
  listAutomations,
  updateAutomation,
} from "../../../db";
import type { ToolDefinition } from "../tool-registry";

const scheduleKindSchema = z.enum(["interval", "daily", "weekly", "cron"]);
const automationTypeSchema = z.enum(["thread", "standalone", "project"]);
const runModeSchema = z.enum(["local", "worktree"]);

const automationFieldsSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  type: automationTypeSchema.optional(),
  scheduleKind: scheduleKindSchema.optional(),
  scheduleValue: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  threadId: z.string().nullable().optional(),
  workspacePaths: z.array(z.string().min(1)).nullable().optional(),
  runMode: runModeSchema.nullable().optional(),
  modelId: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
});

const automationUpdateSchema = z.object({
  action: z.enum(["create", "update", "delete", "list"]),
  automation: automationFieldsSchema.optional(),
  filter: z
    .object({
      enabled: z.boolean().optional(),
      type: automationTypeSchema.optional(),
      threadId: z.string().optional(),
    })
    .optional(),
});

type AutomationUpdateInput = z.infer<typeof automationUpdateSchema>;

interface AutomationToolOptions {
  currentThreadId?: string;
  currentWorkspacePath?: string;
}

const requireAutomation = (
  input: AutomationUpdateInput,
): NonNullable<AutomationUpdateInput["automation"]> => {
  if (!input.automation) {
    throw new Error(`automation is required for ${input.action}`);
  }
  return input.automation;
};

const requireCreateFields = (
  automation: NonNullable<AutomationUpdateInput["automation"]>,
) => {
  const missing = [
    !automation.title && "title",
    !automation.prompt && "prompt",
    !automation.type && "type",
    !automation.scheduleKind && "scheduleKind",
    !automation.scheduleValue && "scheduleValue",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Missing required automation fields: ${missing.join(", ")}`,
    );
  }
};

export const buildAutomationUpdateTool = ({
  currentThreadId,
  currentWorkspacePath,
}: AutomationToolOptions = {}): ToolDefinition<
  AutomationUpdateInput,
  unknown
> => ({
  name: "automation_update",
  description: [
    "Create, update, delete, or list Codex-style automations for recurring background work.",
    "Use this whenever the user asks to create, view, update, delete, schedule, remind, monitor, or follow up later.",
    "Choose type='thread' for heartbeat-style wakeups that should preserve this conversation's context; if threadId is omitted, the current thread/session id is used.",
    "Choose type='standalone' or type='project' when each run should be independent or span one or more projects.",
    "Use durable prompts: say what to do each run, how to decide whether there are findings, and when to stop or ask the user for input.",
    "Schedules: interval values look like '15m', '1h', or '2d'; daily values use 'HH:mm'; weekly values use '<weekday> HH:mm'; cron values are stored verbatim.",
    "For Git repositories, runMode='worktree' isolates automation changes; runMode='local' works directly in the project.",
  ].join(" "),
  safety: "destructive",
  inputSchema: automationUpdateSchema,
  execute: async (input) => {
    if (input.action === "list") {
      return {
        action: "list",
        automations: listAutomations(input.filter),
      };
    }

    const automation = requireAutomation(input);

    if (input.action === "delete") {
      if (!automation.id) throw new Error("automation.id is required");
      return {
        action: "delete",
        id: automation.id,
        deleted: deleteAutomation(automation.id),
      };
    }

    if (input.action === "update") {
      if (!automation.id) throw new Error("automation.id is required");
      const { id: _id, ...updates } = automation;
      return {
        action: "update",
        automation: updateAutomation(automation.id, updates),
      };
    }

    requireCreateFields(automation);
    const type = automation.type as AutomationType;
    const threadId =
      type === "thread"
        ? (automation.threadId ?? currentThreadId ?? null)
        : (automation.threadId ?? null);
    const workspacePaths =
      automation.workspacePaths ??
      (type === "project" && currentWorkspacePath
        ? [currentWorkspacePath]
        : null);

    return {
      action: "create",
      automation: createAutomation({
        title: automation.title ?? "",
        prompt: automation.prompt ?? "",
        type,
        scheduleKind: automation.scheduleKind as AutomationScheduleKind,
        scheduleValue: automation.scheduleValue ?? "",
        enabled: automation.enabled,
        threadId,
        workspacePaths,
        runMode: (automation.runMode ?? null) as AutomationRunMode | null,
        modelId: automation.modelId ?? null,
        reasoningEffort: automation.reasoningEffort ?? null,
      }),
    };
  },
});
