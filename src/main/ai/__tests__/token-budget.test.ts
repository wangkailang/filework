import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  estimateTokens,
  truncateToFit,
  DEFAULT_TOKEN_BUDGET,
} from "../token-budget";

// ---------------------------------------------------------------------------
// Helper to build messages quickly
// ---------------------------------------------------------------------------

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantMsg(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

function toolResultMsg(
  toolCallId: string,
  toolName: string,
  value: string,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value },
      },
    ],
  };
}

function assistantWithToolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): ModelMessage {
  return {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId, toolName, input },
    ],
  };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty messages array", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("estimates tokens as Math.ceil(chars / 4) for string content", () => {
    // "Hello" = 5 chars → Math.ceil(5/4) = 2
    expect(estimateTokens([userMsg("Hello")])).toBe(2);
  });

  it("estimates tokens for longer string content", () => {
    // 100 chars → Math.ceil(100/4) = 25
    const text = "a".repeat(100);
    expect(estimateTokens([userMsg(text)])).toBe(25);
  });

  it("rounds up for non-divisible char counts", () => {
    // 7 chars → Math.ceil(7/4) = 2
    expect(estimateTokens([userMsg("abcdefg")])).toBe(2);
  });

  it("sums tokens across multiple messages", () => {
    // "abcd" = 4 chars → 1 token, "efgh" = 4 chars → 1 token
    expect(estimateTokens([userMsg("abcd"), assistantMsg("efgh")])).toBe(2);
  });

  it("handles single character string", () => {
    // 1 char → Math.ceil(1/4) = 1
    expect(estimateTokens([userMsg("x")])).toBe(1);
  });

  it("handles empty string content", () => {
    // 0 chars → Math.ceil(0/4) = 0
    expect(estimateTokens([userMsg("")])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// truncateToFit — empty / within budget
// ---------------------------------------------------------------------------

describe("truncateToFit", () => {
  it("returns empty array for empty messages", () => {
    const result = truncateToFit([], 1000);
    expect(result.messages).toEqual([]);
    expect(result.wasTruncated).toBe(false);
  });

  it("returns messages unchanged when within budget", () => {
    const msgs: ModelMessage[] = [userMsg("Hi"), assistantMsg("Hello")];
    const result = truncateToFit(msgs, 1000);
    expect(result.messages).toEqual(msgs);
    expect(result.wasTruncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Tool result compression
  // -------------------------------------------------------------------------

  it("compresses large tool results (> 2000 chars)", () => {
    const largeValue = "x".repeat(3000);
    const msgs: ModelMessage[] = [
      assistantWithToolCall("tc1", "readFile"),
      toolResultMsg("tc1", "readFile", largeValue),
    ];
    // Budget large enough to hold compressed but not original
    const originalTokens = estimateTokens(msgs);
    const result = truncateToFit(msgs, originalTokens - 1);

    // Should have compressed the tool result
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (toolMsg && Array.isArray(toolMsg.content)) {
      const toolResult = toolMsg.content[0];
      if (toolResult.type === "tool-result") {
        expect(toolResult.output).toEqual({
          type: "text",
          value: "[工具结果已压缩]",
        });
      }
    }
  });

  it("does not compress small tool results (<= 2000 chars)", () => {
    const smallValue = "x".repeat(100);
    const msgs: ModelMessage[] = [
      assistantWithToolCall("tc1", "readFile"),
      toolResultMsg("tc1", "readFile", smallValue),
    ];
    const result = truncateToFit(msgs, 100000);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (toolMsg && Array.isArray(toolMsg.content)) {
      const toolResult = toolMsg.content[0];
      if (toolResult.type === "tool-result") {
        expect(toolResult.output).toEqual({
          type: "text",
          value: smallValue,
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Early message removal
  // -------------------------------------------------------------------------

  it("removes early messages when over budget", () => {
    const msgs: ModelMessage[] = [
      userMsg("a".repeat(400)),   // 100 tokens
      assistantMsg("b".repeat(400)), // 100 tokens
      userMsg("c".repeat(400)),   // 100 tokens
    ];
    // Budget of 150 tokens — should remove early messages, keep recent
    const result = truncateToFit(msgs, 150);
    expect(result.wasTruncated).toBe(true);
    // The last message should be preserved
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toBe("c".repeat(400));
  });

  // -------------------------------------------------------------------------
  // Truncation notice
  // -------------------------------------------------------------------------

  it("inserts truncation notice when messages are truncated", () => {
    const msgs: ModelMessage[] = [
      userMsg("a".repeat(400)),
      assistantMsg("b".repeat(400)),
      userMsg("c".repeat(40)),
    ];
    // Small budget to force truncation
    const result = truncateToFit(msgs, 50);
    expect(result.wasTruncated).toBe(true);
    // First message should be the truncation notice
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("省略");
  });

  // -------------------------------------------------------------------------
  // Budget <= 0 fallback
  // -------------------------------------------------------------------------

  it("uses DEFAULT_TOKEN_BUDGET when budget is 0", () => {
    const msgs: ModelMessage[] = [userMsg("Hello")];
    const result = truncateToFit(msgs, 0);
    // "Hello" = 2 tokens, well within 80000 default
    expect(result.wasTruncated).toBe(false);
    expect(result.messages).toEqual(msgs);
  });

  it("uses DEFAULT_TOKEN_BUDGET when budget is negative", () => {
    const msgs: ModelMessage[] = [userMsg("Hello")];
    const result = truncateToFit(msgs, -100);
    expect(result.wasTruncated).toBe(false);
    expect(result.messages).toEqual(msgs);
  });

  it("uses DEFAULT_TOKEN_BUDGET when budget is undefined", () => {
    const msgs: ModelMessage[] = [userMsg("Hello")];
    const result = truncateToFit(msgs);
    expect(result.wasTruncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Single message over budget — text truncation
  // -------------------------------------------------------------------------

  it("truncates text of a single message that exceeds budget", () => {
    // 1000 chars = 250 tokens. Budget of 10 tokens = 40 chars max
    const msgs: ModelMessage[] = [userMsg("a".repeat(1000))];
    const result = truncateToFit(msgs, 10);
    expect(result.wasTruncated).toBe(true);
    // Should have truncation notice + truncated message
    const contentMsgs = result.messages.filter((m) => m.role !== "system");
    expect(contentMsgs.length).toBe(1);
    // The content should be shorter than original
    const content = contentMsgs[0].content as string;
    expect(content.length).toBeLessThan(1000);
  });

  // -------------------------------------------------------------------------
  // DEFAULT_TOKEN_BUDGET constant
  // -------------------------------------------------------------------------

  it("exports DEFAULT_TOKEN_BUDGET as 80000", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(80000);
  });
});
