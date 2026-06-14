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
    toolName_spawnSubagent: () =>
      locale === "zh" ? "启动子任务" : "Start Subagents",
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
