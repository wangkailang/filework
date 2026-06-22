import { describe, expect, it } from "vitest";
import type { BatchApprovalEntry } from "../../../../main/core/session/message-parts";
import type { TranslationFunctions } from "../../../i18n/i18n-types";
import {
  getBatchApprovalTitle,
  summarizeBatchEntry,
} from "../confirmation-copy";

const makeLL = (locale: "en" | "zh"): TranslationFunctions =>
  ({
    approval_batch_title_single: (label: string) =>
      locale === "zh" ? `批准${label}？` : `Approve ${label}?`,
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

    expect(title).toBe("批准管理自动化？");
    expect(title).not.toContain("automation_update");
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
