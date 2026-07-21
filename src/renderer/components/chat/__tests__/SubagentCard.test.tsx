import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

    expect(html.match(/进行中/g)).toHaveLength(4);
    expect(html.match(/排队中/g)).toHaveLength(2);
    expect(html).toContain("完成 0/6");
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

    expect(html.match(/部分可用/g)).toHaveLength(3);
    expect(html).toContain("可用 2/2");
    expect(html).not.toContain("含失败");
    expect(html).not.toContain("token 超限");
    expect(html).not.toContain("超时");
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

    expect(html).toContain("可用 0/2");
    expect(html).toContain("截断 2");
    expect(html.match(/已截断/g)).toHaveLength(2);
    expect(html).not.toContain("部分可用");
  });
});
