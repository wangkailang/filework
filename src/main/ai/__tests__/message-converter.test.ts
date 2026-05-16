import { describe, expect, it } from "vitest";
import {
  convertToCoreMessages,
  type HistoryMessage,
} from "../message-converter";

describe("convertToCoreMessages", () => {
  it("returns empty array for empty history", async () => {
    expect(await convertToCoreMessages([])).toEqual([]);
  });

  it("converts user message to { role: 'user', content }", async () => {
    const history: HistoryMessage[] = [{ role: "user", content: "Hello" }];
    const result = await convertToCoreMessages(history);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts assistant message with TextPart", async () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: "Hi there",
        parts: [{ type: "text", text: "Hi there" }],
      },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ]);
  });

  it("converts assistant message with ToolPart into tool-call + tool-result", async () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool",
            toolCallId: "tc1",
            toolName: "readFile",
            args: { path: "/test.txt" },
            result: { content: "file content" },
            state: "result",
          },
        ],
      },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toHaveLength(2);

    // Assistant message with tool-call
    expect(result[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "readFile",
          input: { path: "/test.txt" },
        },
      ],
    });

    // Tool role message with tool-result
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "readFile",
          output: { type: "text", value: '{"content":"file content"}' },
        },
      ],
    });
  });

  it("uses placeholder when ToolPart has no result", async () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool",
            toolCallId: "tc2",
            toolName: "listDir",
            args: {},
            state: "call",
          },
        ],
      },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toHaveLength(2);
    const toolMsg = result[1];
    expect(toolMsg.role).toBe("tool");
    if (toolMsg.role === "tool") {
      const toolResult = toolMsg.content[0];
      if (toolResult.type === "tool-result") {
        expect(toolResult.output).toEqual({
          type: "text",
          value: "[工具执行结果未记录]",
        });
      }
    }
  });

  it("ignores PlanMessagePart", async () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: "some text",
        parts: [
          { type: "text", text: "some text" },
          { type: "plan", plan: { id: "p1", steps: [] } },
        ],
      },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "some text" }],
    });
  });

  it("handles mixed TextPart and ToolPart in one assistant message", async () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: "Let me check that file",
        parts: [
          { type: "text", text: "Let me check that file" },
          {
            type: "tool",
            toolCallId: "tc3",
            toolName: "readFile",
            args: { path: "/a.txt" },
            result: "content of a",
            state: "result",
          },
        ],
      },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toHaveLength(2);

    // Assistant message has both text and tool-call
    expect(result[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that file" },
        {
          type: "tool-call",
          toolCallId: "tc3",
          toolName: "readFile",
          input: { path: "/a.txt" },
        },
      ],
    });

    // Tool result message
    expect(result[1].role).toBe("tool");
  });

  it("preserves chronological order of messages", async () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "First" },
      {
        role: "assistant",
        content: "Second",
        parts: [{ type: "text", text: "Second" }],
      },
      { role: "user", content: "Third" },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "First" });
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Second" }],
    });
    expect(result[2]).toEqual({ role: "user", content: "Third" });
  });

  it("handles assistant message with no parts using content string", async () => {
    const history: HistoryMessage[] = [
      { role: "assistant", content: "Plain text response" },
    ];
    const result = await convertToCoreMessages(history);
    expect(result).toEqual([
      { role: "assistant", content: "Plain text response" },
    ]);
  });

  it("skips assistant message with empty content and no parts", async () => {
    const history: HistoryMessage[] = [{ role: "assistant", content: "" }];
    const result = await convertToCoreMessages(history);
    expect(result).toEqual([]);
  });
});
