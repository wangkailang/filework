import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { repairMissingToolResults } from "../context-safety";

const assistantToolCall = (
  toolCallId: string,
  toolName = "readFile",
): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId, toolName, input: {} }],
});

const toolResult = (
  toolCallId: string,
  toolName = "readFile",
): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output: { type: "text", value: "ok" },
    },
  ],
});

describe("repairMissingToolResults", () => {
  it("inserts a placeholder tool result before the next non-tool message", () => {
    const result = repairMissingToolResults([
      assistantToolCall("call-missing", "searchFiles"),
      { role: "user", content: "continue" },
    ]);

    expect(result.repairedToolCallIds).toEqual(["call-missing"]);
    expect(result.messages).toEqual([
      assistantToolCall("call-missing", "searchFiles"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-missing",
            toolName: "searchFiles",
            output: {
              type: "text",
              value: "[工具结果未保留：上下文压缩已移除旧结果]",
            },
          },
        ],
      },
      { role: "user", content: "continue" },
    ]);
  });

  it("leaves complete tool call/result pairs unchanged", () => {
    const messages: ModelMessage[] = [
      assistantToolCall("call-ok"),
      toolResult("call-ok"),
      { role: "user", content: "continue" },
    ];

    const result = repairMissingToolResults(messages);

    expect(result.repairedToolCallIds).toEqual([]);
    expect(result.messages).toBe(messages);
  });
});
