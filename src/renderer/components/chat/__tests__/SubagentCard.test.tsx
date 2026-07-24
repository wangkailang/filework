import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      subagent_delegation: () => "Delegated tasks",
      subagent_failedCount: (count: string) => `Failed ${count}`,
      subagent_partialCount: (count: string) => `Partial ${count}`,
      subagent_statusCancelled: () => "Cancelled",
      subagent_statusFailed: () => "Failed",
      subagent_statusNoResult: () => "No result",
      subagent_statusOk: () => "Complete",
      subagent_statusPartial: () => "Partial",
      subagent_statusQueued: () => "Queued",
      subagent_statusRunning: () => "Running",
      subagent_statusTimeout: () => "Timed out",
      subagent_statusTokenLimit: () => "Token limit",
      subagent_statusTruncated: () => "Truncated",
      subagent_steps: (count: string) => `${count} steps`,
      subagent_summary: (children: string, concurrency: string, done: string) =>
        `${children} tasks · concurrency ${concurrency} · ${done} complete`,
      subagent_truncatedCount: (count: string) => `Truncated ${count}`,
      subagent_usable: (usable: string, total: string) =>
        `${usable}/${total} usable`,
      subagent_viewTrace: (goal: string) => `View execution for ${goal}`,
    },
  }),
}));

import { SubagentCard } from "../SubagentCard";
import type { SubagentMessagePart } from "../types";

const child = (
  childTaskId: string,
  status: SubagentMessagePart["children"][number]["status"],
  summary?: string,
  resultQuality?: SubagentMessagePart["children"][number]["resultQuality"],
): SubagentMessagePart["children"][number] => ({
  childTaskId,
  goal: `分析 ${childTaskId}`,
  status,
  stepCount: 0,
  toolCalls: [],
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  },
  summary,
  resultQuality,
});

describe("SubagentCard", () => {
  it("renders queued children separately from running children", () => {
    const part: SubagentMessagePart = {
      type: "subagent",
      batchId: "batch-1",
      toolCallId: "spawn-1",
      concurrency: 4,
      children: [
        child("child-1", "running"),
        child("child-2", "running"),
        child("child-3", "running"),
        child("child-4", "running"),
        child("child-5", "queued"),
        child("child-6", "queued"),
      ],
    };

    const html = renderToStaticMarkup(<SubagentCard part={part} />);

    expect(html.match(/>Running<\/span>/g)).toHaveLength(4);
    expect(html.match(/>Queued<\/span>/g)).toHaveLength(2);
    expect(html).toContain("6 tasks · concurrency 4 · 0 complete");
  });

  it("counts partial results as usable evidence while preserving follow-up state", () => {
    const part: SubagentMessagePart = {
      type: "subagent",
      batchId: "batch-1",
      toolCallId: "spawn-1",
      concurrency: 2,
      children: [
        child("child-1", "token_limit", "已有可用摘要", "usable_partial"),
        child("child-2", "timeout", "已有可用摘要", "usable_partial"),
      ],
    };

    const html = renderToStaticMarkup(<SubagentCard part={part} />);

    expect(html.match(/>Partial<\/span>/g)).toHaveLength(2);
    expect(html).toContain("Partial 2");
    expect(html).toContain("2/2 usable");
    expect(html).not.toContain("含失败");
    expect(html).not.toContain("Token limit");
    expect(html).not.toContain("Timed out");
  });

  it("does not treat startup summaries as partial results", () => {
    const part: SubagentMessagePart = {
      type: "subagent",
      batchId: "batch-1",
      toolCallId: "spawn-1",
      concurrency: 2,
      children: [
        child("child-1", "token_limit", "我将开始分析目录。", "no_result"),
        child("child-2", "timeout", "我将读取关键文件。", "no_result"),
      ],
    };

    const html = renderToStaticMarkup(<SubagentCard part={part} />);

    expect(html).toContain("0/2 usable");
    expect(html).toContain("Truncated 2");
    expect(html.match(/>Truncated<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain("Partial");
  });

  it("uses semantic status colors instead of palette utilities", () => {
    const part: SubagentMessagePart = {
      type: "subagent",
      batchId: "batch-1",
      toolCallId: "spawn-1",
      concurrency: 2,
      children: [child("child-1", "running"), child("child-2", "failed")],
    };

    const html = renderToStaticMarkup(<SubagentCard part={part} />);

    expect(html).toContain("text-status-running");
    expect(html).toContain("text-status-error");
    expect(html).not.toMatch(/text-(?:blue|emerald|red|amber)-[0-9]+/);
  });
});
