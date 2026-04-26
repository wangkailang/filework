import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  getTokenBudgetForModel,
  TOOL_RESULT_COMPRESS_THRESHOLD_CHARS,
  truncateToFit,
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
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty messages array", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("estimates Latin text at ~4 chars per token", () => {
    // "Hello" = 5 Latin chars → ceil(5/4) = 2
    expect(estimateTokens([userMsg("Hello")])).toBe(2);
  });

  it("estimates longer Latin text correctly", () => {
    // 100 Latin chars → ceil(100/4) = 25
    const text = "a".repeat(100);
    expect(estimateTokens([userMsg(text)])).toBe(25);
  });

  it("estimates CJK text at ~1.5 chars per token", () => {
    // 6 CJK chars → ceil(6/1.5) = 4
    expect(estimateTokens([userMsg("你好世界测试")])).toBe(4);
  });

  it("handles mixed CJK and Latin text", () => {
    // "Hello你好" = 5 Latin + 2 CJK → ceil(2/1.5 + 5/4) = ceil(1.33 + 1.25) = 3
    expect(estimateTokens([userMsg("Hello你好")])).toBe(3);
  });

  it("sums tokens across multiple messages", () => {
    // "abcd" = 4 Latin → 1 token, "efgh" = 4 Latin → 1 token
    expect(estimateTokens([userMsg("abcd"), assistantMsg("efgh")])).toBe(2);
  });

  it("handles single character string", () => {
    // 1 Latin char → ceil(1/4) = 1
    expect(estimateTokens([userMsg("x")])).toBe(1);
  });

  it("handles empty string content", () => {
    expect(estimateTokens([userMsg("")])).toBe(0);
  });

  it("CJK estimates are significantly higher than old chars/4 method", () => {
    // 100 CJK chars: old method would give ceil(100/4)=25, new gives ceil(100/1.5)=67
    const cjkText = "测".repeat(100);
    const estimate = estimateTokens([userMsg(cjkText)]);
    expect(estimate).toBe(67);
    expect(estimate).toBeGreaterThan(25); // confirms the fix
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
      userMsg("a".repeat(400)), // 100 tokens
      assistantMsg("b".repeat(400)), // 100 tokens
      userMsg("c".repeat(400)), // 100 tokens
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
    // 1000 Latin chars = 250 tokens. Budget of 10 tokens.
    // With conservative CJK ratio (1.5 chars/token), maxChars = 10 * 1.5 = 15
    const msgs: ModelMessage[] = [userMsg("a".repeat(1000))];
    const result = truncateToFit(msgs, 10);
    expect(result.wasTruncated).toBe(true);
    const contentMsgs = result.messages.filter((m) => m.role !== "system");
    expect(contentMsgs.length).toBe(1);
    const content = contentMsgs[0].content as string;
    expect(content.length).toBeLessThan(1000);
  });

  // -------------------------------------------------------------------------
  // DEFAULT_TOKEN_BUDGET constant
  // -------------------------------------------------------------------------

  it("exports DEFAULT_TOKEN_BUDGET as 80000", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(80_000);
  });

  it("exports TOOL_RESULT_COMPRESS_THRESHOLD_CHARS as 2000", () => {
    expect(TOOL_RESULT_COMPRESS_THRESHOLD_CHARS).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// getTokenBudgetForModel
// ---------------------------------------------------------------------------

describe("getTokenBudgetForModel", () => {
  it("returns correct budget for Claude models", () => {
    // 200K context - 8192 output - 2000 safety = 189808
    expect(getTokenBudgetForModel("claude-3.5-sonnet-20241022")).toBe(189_808);
    expect(getTokenBudgetForModel("claude-opus-4-20250514")).toBe(189_808);
  });

  it("returns correct budget for GPT-4o", () => {
    // 128K - 8192 - 2000 = 117808
    expect(getTokenBudgetForModel("gpt-4o")).toBe(117_808);
    expect(getTokenBudgetForModel("gpt-4o-mini")).toBe(117_808);
  });

  it("returns correct budget for DeepSeek models", () => {
    // 64K - 8192 - 2000 = 53808
    expect(getTokenBudgetForModel("deepseek-chat")).toBe(53_808);
  });

  it("returns DEFAULT_TOKEN_BUDGET for unknown models", () => {
    expect(getTokenBudgetForModel("some-unknown-model")).toBe(
      DEFAULT_TOKEN_BUDGET,
    );
  });

  it("is case-insensitive", () => {
    expect(getTokenBudgetForModel("Claude-3.5-Sonnet")).toBe(189_808);
    expect(getTokenBudgetForModel("GPT-4o")).toBe(117_808);
  });
});
