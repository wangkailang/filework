import { describe, expect, it } from "vitest";
import type { BatchApprovalEntry } from "../../../../main/core/session/message-parts";
import type { TranslationFunctions } from "../../../i18n/i18n-types";
import {
  getBatchAlwaysAllowLabel,
  getBatchApprovalTitle,
  getBatchApproveLabel,
  summarizeBatchEntry,
} from "../confirmation-copy";

const makeLL = (locale: "en" | "zh"): TranslationFunctions =>
  ({
    approval_batch_title_single: (label: string) =>
      locale === "zh" ? `批准${label}？` : `Approve ${label}?`,
    approval_batch_approve_all: (count: number) =>
      locale === "zh" ? `批准全部 ${count} 个` : `Approve all ${count}`,
    approval_batch_always_allow: (label: string) =>
      locale === "zh" ? `始终允许${label}` : `Always allow ${label}`,
    approval_automationUpdate_title: () =>
      locale === "zh" ? "批准自动化变更？" : "Approve automation changes?",
    approval_automationUpdate_approve_once: () =>
      locale === "zh" ? "批准本次变更" : "Approve this change",
    approval_automationUpdate_always_allow: () =>
      locale === "zh"
        ? "始终允许自动化变更"
        : "Always allow automation changes",
    approval_automationUpdate_summary_change: () =>
      locale === "zh" ? "将修改自动化配置" : "Will change automation settings",
    approval_automationUpdate_summary_create: () =>
      locale === "zh" ? "将创建自动化任务" : "Will create an automation",
    approval_automationUpdate_summary_update: () =>
      locale === "zh" ? "将更新自动化任务" : "Will update an automation",
    approval_automationUpdate_summary_delete: () =>
      locale === "zh" ? "将删除自动化任务" : "Will delete an automation",
    approval_automationUpdate_summary_list: () =>
      locale === "zh" ? "将查看自动化任务列表" : "Will list automations",
    approval_spawnSubagent_summary: (taskCount: number, concurrency: number) =>
      locale === "zh"
        ? `${taskCount} 个子任务 · 并发 ${concurrency}`
        : `${taskCount} subagents · concurrency ${concurrency}`,
    toolName_createDirectory: () => "createDirectory",
    toolName_deleteFile: () => "deleteFile",
    toolName_directoryStats: () => "directoryStats",
    toolName_findDuplicates: () => "findDuplicates",
    toolName_listDirectory: () => "listDirectory",
    toolName_moveFile: () => "moveFile",
    toolName_readFile: () => "readFile",
    toolName_runCommand: () => "runCommand",
    toolName_runProcess: () => "runProcess",
    toolName_spawnSubagent: () =>
      locale === "zh" ? "启动子任务" : "Start Subagents",
    toolName_automationUpdate: () =>
      locale === "zh" ? "管理自动化" : "Manage Automations",
    toolName_webFetch: () => "webFetch",
    toolName_webFetchRendered: () => "webFetchRendered",
    toolName_webScrape: () => "webScrape",
    toolName_webSearch: () => "webSearch",
    toolName_writeFile: () => "writeFile",
    toolName_youtubeTranscript: () => "youtubeTranscript",
  }) as unknown as TranslationFunctions;

const spawnEntry = (args: unknown): BatchApprovalEntry => ({
  toolCallId: "call-1",
  args,
  description: "批准spawnSubagent操作?",
});

describe("confirmation copy", () => {
  it("localizes spawnSubagent approval title instead of mixing raw tool name", () => {
    const title = getBatchApprovalTitle({
      LL: makeLL("zh"),
      toolName: "spawnSubagent",
      entries: [spawnEntry({ tasks: [{ goal: "a" }], concurrency: 1 })],
    });

    expect(title).toBe("批准启动子任务？");
    expect(title).not.toContain("spawnSubagent");
  });

  it("localizes automation update approval title", () => {
    const title = getBatchApprovalTitle({
      LL: makeLL("zh"),
      toolName: "automation_update",
      entries: [
        {
          toolCallId: "call-automation",
          args: { action: "create" },
          description: "automation_update",
        },
      ],
    });

    expect(title).toBe("批准自动化变更？");
    expect(title).not.toContain("automation_update");
  });

  it("uses explicit automation update copy for summary and action labels", () => {
    const entry: BatchApprovalEntry = {
      toolCallId: "call-automation",
      args: { action: "update" },
      description: "automation_update",
    };
    const LL = makeLL("zh");

    expect(summarizeBatchEntry("automation_update", entry, LL)).toBe(
      "将更新自动化任务",
    );
    expect(
      getBatchApproveLabel({ LL, toolName: "automation_update", count: 1 }),
    ).toBe("批准本次变更");
    expect(
      getBatchAlwaysAllowLabel({ LL, toolName: "automation_update" }),
    ).toBe("始终允许自动化变更");
  });

  it("summarizes spawnSubagent args as task count and concurrency", () => {
    expect(
      summarizeBatchEntry(
        "spawnSubagent",
        spawnEntry({
          tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }],
          concurrency: 2,
        }),
        makeLL("en"),
      ),
    ).toBe("3 subagents · concurrency 2");
  });
});
