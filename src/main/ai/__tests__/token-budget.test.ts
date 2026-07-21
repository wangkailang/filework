import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  COMPRESSION_TARGET_RATIO,
  COMPRESSION_TRIGGER_RATIO,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  getCompressionTargetBudget,
  getCompressionTriggerBudget,
  getTokenBudget,
  getTokenBudgetForModel,
  TOOL_RESULT_COMPRESS_THRESHOLD_CHARS,
  truncateToFit,
  truncateToFitAsync,
} from "../token-budget";

// ---------------------------------------------------------------------------
// 快速构建消息的辅助函数
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
    // "Hello" = 5 个拉丁字符 → ceil(5/4) = 2
    expect(estimateTokens([userMsg("Hello")])).toBe(2);
  });

  it("estimates longer Latin text correctly", () => {
    // 100 个拉丁字符 → ceil(100/4) = 25
    const text = "a".repeat(100);
    expect(estimateTokens([userMsg(text)])).toBe(25);
  });

  it("estimates CJK text at ~1.5 chars per token", () => {
    // 6 个 CJK 字符 → ceil(6/1.5) = 4
    expect(estimateTokens([userMsg("你好世界测试")])).toBe(4);
  });

  it("handles mixed CJK and Latin text", () => {
    // "Hello你好" = 5 个拉丁字符 + 2 个 CJK 字符 → ceil(2/1.5 + 5/4) = ceil(1.33 + 1.25) = 3
    expect(estimateTokens([userMsg("Hello你好")])).toBe(3);
  });

  it("sums tokens across multiple messages", () => {
    // "abcd" = 4 个拉丁字符 → 1 token,"efgh" = 4 个拉丁字符 → 1 token
    expect(estimateTokens([userMsg("abcd"), assistantMsg("efgh")])).toBe(2);
  });

  it("handles single character string", () => {
    // 1 个拉丁字符 → ceil(1/4) = 1
    expect(estimateTokens([userMsg("x")])).toBe(1);
  });

  it("handles empty string content", () => {
    expect(estimateTokens([userMsg("")])).toBe(0);
  });

  it("CJK estimates are significantly higher than old chars/4 method", () => {
    // 100 个 CJK 字符:旧方法得 ceil(100/4)=25,新方法得 ceil(100/1.5)=67
    const cjkText = "测".repeat(100);
    const estimate = estimateTokens([userMsg(cjkText)]);
    expect(estimate).toBe(67);
    expect(estimate).toBeGreaterThan(25); // 验证修复生效
  });
});

// ---------------------------------------------------------------------------
// truncateToFit —— 空 / 在预算范围内
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
  // 工具结果压缩
  // -------------------------------------------------------------------------

  it("compresses large tool results (> 2000 chars)", () => {
    const largeValue = "x".repeat(3000);
    const msgs: ModelMessage[] = [
      assistantWithToolCall("tc1", "readFile"),
      toolResultMsg("tc1", "readFile", largeValue),
    ];
    // 预算足以容纳压缩后的结果,但容不下原始结果
    const originalTokens = estimateTokens(msgs);
    const result = truncateToFit(msgs, originalTokens - 1);

    // 应已压缩工具结果
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
  // 移除靠前的消息
  // -------------------------------------------------------------------------

  it("removes early messages when over budget", () => {
    const msgs: ModelMessage[] = [
      userMsg("a".repeat(400)), // 100 个 token
      assistantMsg("b".repeat(400)), // 100 个 token
      userMsg("c".repeat(400)), // 100 个 token
    ];
    // 预算为 150 个 token —— 应移除靠前的消息,保留最近的
    const result = truncateToFit(msgs, 150);
    expect(result.wasTruncated).toBe(true);
    // 最后一条消息应被保留
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toBe("c".repeat(400));
  });

  it("hard-retains the configured recent chat window before dropping older messages", () => {
    const recent: ModelMessage[] = [
      assistantMsg("recent assistant kept"),
      userMsg("recent user kept"),
      assistantMsg("recent answer kept"),
    ];
    const msgs: ModelMessage[] = [
      userMsg("old-1 ".repeat(300)),
      assistantMsg("old-2 ".repeat(300)),
      userMsg("old-3 ".repeat(300)),
      ...recent,
    ];

    const result = truncateToFit(msgs, 80, { recentMessageCount: 3 });
    const nonNoticeMessages = result.messages.filter(
      (m) => m.role !== "system",
    );

    expect(result.wasTruncated).toBe(true);
    expect(result.messagesDropped).toBe(3);
    expect(nonNoticeMessages).toEqual(recent);
    expect(estimateTokens(result.messages)).toBeLessThanOrEqual(80);
  });

  it("trims recent message text instead of dropping recent messages under a tight budget", () => {
    const msgs: ModelMessage[] = [
      userMsg("old context ".repeat(300)),
      userMsg("recent user ".repeat(300)),
      assistantMsg("recent assistant ".repeat(300)),
    ];

    const result = truncateToFit(msgs, 35, { recentMessageCount: 2 });
    const nonNoticeMessages = result.messages.filter(
      (m) => m.role !== "system",
    );

    expect(result.wasTruncated).toBe(true);
    expect(nonNoticeMessages).toHaveLength(2);
    expect(nonNoticeMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(nonNoticeMessages[0].content).not.toBe(msgs[1].content);
    expect(nonNoticeMessages[1].content).not.toBe(msgs[2].content);
    expect(estimateTokens(result.messages)).toBeLessThanOrEqual(35);
  });

  // -------------------------------------------------------------------------
  // 截断提示
  // -------------------------------------------------------------------------

  it("inserts truncation notice when messages are truncated", () => {
    const msgs: ModelMessage[] = [
      userMsg("a".repeat(400)),
      assistantMsg("b".repeat(400)),
      userMsg("c".repeat(40)),
    ];
    // 用较小的预算强制触发截断
    const result = truncateToFit(msgs, 50);
    expect(result.wasTruncated).toBe(true);
    // 第一条消息应为截断提示
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("省略");
  });

  // -------------------------------------------------------------------------
  // 预算 <= 0 时的回退
  // -------------------------------------------------------------------------

  it("uses DEFAULT_TOKEN_BUDGET when budget is 0", () => {
    const msgs: ModelMessage[] = [userMsg("Hello")];
    const result = truncateToFit(msgs, 0);
    // "Hello" = 2 个 token,远在 80000 默认值之内
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
  // 单条消息超出预算 —— 文本截断
  // -------------------------------------------------------------------------

  it("truncates text of a single message that exceeds budget", () => {
    // 1000 个拉丁字符 = 250 个 token。预算为 10 个 token。
    // 采用保守的 CJK 比率(1.5 字符/token),maxChars = 10 * 1.5 = 15
    const msgs: ModelMessage[] = [userMsg("a".repeat(1000))];
    const result = truncateToFit(msgs, 10);
    expect(result.wasTruncated).toBe(true);
    const contentMsgs = result.messages.filter((m) => m.role !== "system");
    expect(contentMsgs.length).toBe(1);
    const content = contentMsgs[0].content as string;
    expect(content.length).toBeLessThan(1000);
  });

  // -------------------------------------------------------------------------
  // DEFAULT_TOKEN_BUDGET 常量
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
    // 200K 上下文 - 8192 输出 - 2000 安全余量 = 189808
    expect(getTokenBudgetForModel("claude-3.5-sonnet-20241022")).toBe(189_808);
    expect(getTokenBudgetForModel("claude-opus-4-20250514")).toBe(189_808);
  });

  it("returns correct budget for GPT-4o", () => {
    // 128K - 8192 - 2000 = 117808
    expect(getTokenBudgetForModel("gpt-4o")).toBe(117_808);
    expect(getTokenBudgetForModel("gpt-4o-mini")).toBe(117_808);
  });

  it("uses the API 1.05M fallback budget for GPT-5.5 when provider metadata is missing", () => {
    // 1.05M - 8192 - 2000 = 1039808
    expect(getTokenBudgetForModel("gpt-5.5")).toBe(1_039_808);
  });

  it("uses the current 1M context window for DeepSeek V4 and official aliases", () => {
    // 1M - 8192 - 2000 = 989808
    expect(getTokenBudgetForModel("deepseek-v4-pro")).toBe(989_808);
    expect(getTokenBudgetForModel("deepseek-v4-flash")).toBe(989_808);
    expect(getTokenBudgetForModel("deepseek-chat")).toBe(989_808);
    expect(getTokenBudgetForModel("deepseek-reasoner")).toBe(989_808);
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

// ---------------------------------------------------------------------------
// getTokenBudget
// ---------------------------------------------------------------------------

describe("getTokenBudget", () => {
  it("uses configured context window for dynamically refreshed models", () => {
    expect(
      getTokenBudget({
        modelId: "gpt-5.5",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
      }),
    ).toBe(25_904);
  });

  it("falls back to model-name budget when no configured context window exists", () => {
    expect(getTokenBudget({ modelId: "gpt-4o" })).toBe(117_808);
  });
});

describe("getCompressionTriggerBudget", () => {
  it("uses an 85% high-water trigger and a 50% low-water target for GPT-5.5", () => {
    expect(COMPRESSION_TRIGGER_RATIO).toBe(0.85);
    expect(COMPRESSION_TARGET_RATIO).toBe(0.5);
    expect(
      getCompressionTriggerBudget({
        modelId: "gpt-5.5",
      }),
    ).toBe(892_500);
    expect(
      getCompressionTargetBudget({
        modelId: "gpt-5.5",
      }),
    ).toBe(525_000);
  });

  it("reserves dynamic growth headroom below the hard input budget", () => {
    expect(
      getCompressionTriggerBudget({
        contextWindow: 32_000,
        maxOutputTokens: 8_192,
      }),
    ).toBe(18_608);
  });
});

describe("truncateToFitAsync", () => {
  it("compresses from the high-water trigger toward the low-water target", async () => {
    const msgs = [userMsg("a".repeat(3200))]; // ~800 tokens
    const budgets: number[] = [];

    const result = await truncateToFitAsync(
      msgs,
      1_000,
      async (_messages, budget) => {
        budgets.push(budget);
        return {
          messages: [userMsg("compressed")],
          wasCompressed: true,
        };
      },
      {
        compressionTriggerBudget: 700,
        compressionTargetBudget: 500,
      },
    );

    expect(budgets).toEqual([500]);
    expect(result.compressionStage).toBe("llm-summary");
  });

  it("runs LLM compression once history crosses the soft trigger budget", async () => {
    const msgs = [userMsg("a".repeat(3200))]; // ~800 tokens
    let compressorCalls = 0;

    const result = await truncateToFitAsync(
      msgs,
      1000,
      async (_messages, budget) => {
        compressorCalls += 1;
        expect(budget).toBe(700);
        return {
          messages: [userMsg("compressed")],
          wasCompressed: true,
        };
      },
      { compressionTriggerBudget: 700 },
    );

    expect(compressorCalls).toBe(1);
    expect(result.wasTruncated).toBe(true);
    expect(result.compressionStage).toBe("llm-summary");
    expect(result.messages).toEqual([userMsg("compressed")]);
  });

  it("does not run LLM compression below the soft trigger budget", async () => {
    const msgs = [userMsg("a".repeat(2000))]; // 500 tokens
    let compressorCalls = 0;

    const result = await truncateToFitAsync(
      msgs,
      1000,
      async () => {
        compressorCalls += 1;
        return {
          messages: [userMsg("compressed")],
          wasCompressed: true,
        };
      },
      { compressionTriggerBudget: 700 },
    );

    expect(compressorCalls).toBe(0);
    expect(result.wasTruncated).toBe(false);
    expect(result.compressionStage).toBe("none");
    expect(result.messages).toEqual(msgs);
  });

  it("runs LLM compression below the soft trigger budget when forced", async () => {
    const msgs = [userMsg("a".repeat(2000))]; // 500 tokens
    let compressorCalls = 0;

    const result = await truncateToFitAsync(
      msgs,
      1000,
      async (_messages, budget) => {
        compressorCalls += 1;
        expect(budget).toBe(700);
        return {
          messages: [userMsg("compressed")],
          wasCompressed: true,
        };
      },
      { compressionTriggerBudget: 700, forceCompression: true },
    );

    expect(compressorCalls).toBe(1);
    expect(result.wasTruncated).toBe(true);
    expect(result.compressionStage).toBe("llm-summary");
    expect(result.messages).toEqual([userMsg("compressed")]);
  });

  it("keeps original context below the hard budget when compression reports an error", async () => {
    const msgs = [userMsg("old ".repeat(300)), userMsg("latest request")];

    const result = await truncateToFitAsync(
      msgs,
      1_000,
      async () => ({
        messages: [userMsg("latest request")],
        wasCompressed: false,
        hadError: true,
      }),
      { compressionTriggerBudget: 100 },
    );

    expect(result.messages).toEqual(msgs);
    expect(result.compressionStage).toBe("none");
    expect(result.messagesDropped).toBe(0);
  });

  it("uses explicit safe truncation after a compression error above the hard budget", async () => {
    const msgs = [
      userMsg("old-1 ".repeat(300)),
      assistantMsg("old-2 ".repeat(300)),
      userMsg("latest request"),
    ];

    const result = await truncateToFitAsync(
      msgs,
      80,
      async (messages) => ({
        messages,
        wasCompressed: false,
        hadError: true,
      }),
      { recentMessageCount: 1 },
    );

    expect(result.compressionStage).toBe("safe-truncation");
    expect(result.messagesDropped).toBeGreaterThan(0);
    expect(result.messages).toContainEqual(userMsg("latest request"));
  });

  it("runs LLM compression when tool-result compaction is still over the soft trigger budget", async () => {
    const msgs = [
      userMsg("a".repeat(3200)), // ~800 tokens
      toolResultMsg("call-1", "runCommand", "b".repeat(4000)),
    ];
    let compressorCalls = 0;

    const result = await truncateToFitAsync(
      msgs,
      1000,
      async (messages, budget) => {
        compressorCalls += 1;
        expect(budget).toBe(700);
        const compactedTokens = estimateTokens(messages);
        expect(compactedTokens).toBeGreaterThan(700);
        expect(compactedTokens).toBeLessThanOrEqual(1000);
        return {
          messages: [userMsg("compressed")],
          wasCompressed: true,
        };
      },
      { compressionTriggerBudget: 700 },
    );

    expect(compressorCalls).toBe(1);
    expect(result.wasTruncated).toBe(true);
    expect(result.compressionStage).toBe("llm-summary");
    expect(result.messages).toEqual([userMsg("compressed")]);
  });

  it("reports local tool-result compaction when it drops context below the soft trigger budget", async () => {
    const msgs = [
      userMsg("a".repeat(1200)), // ~300 tokens
      toolResultMsg("call-1", "readFile", "b".repeat(4000)),
    ];
    const originalTokens = estimateTokens(msgs);
    let compressorCalls = 0;

    const result = await truncateToFitAsync(
      msgs,
      2_000,
      async () => {
        compressorCalls += 1;
        return {
          messages: [userMsg("compressed")],
          wasCompressed: true,
        };
      },
      { compressionTriggerBudget: 700 },
    );

    expect(compressorCalls).toBe(0);
    expect(result.wasTruncated).toBe(false);
    expect(result.compressionStage).toBe("tool-result-compaction");
    expect(result.toolResultCompaction).toEqual({
      originalTokens,
      compressedTokens: estimateTokens(result.messages),
    });
  });

  it("preserves the recent chat window when falling back after LLM compression fails", async () => {
    const recent: ModelMessage[] = [
      assistantMsg("recent assistant kept"),
      userMsg("recent user kept"),
      assistantMsg("recent answer kept"),
    ];
    const msgs: ModelMessage[] = [
      userMsg("old-1 ".repeat(300)),
      assistantMsg("old-2 ".repeat(300)),
      userMsg("old-3 ".repeat(300)),
      ...recent,
    ];

    const result = await truncateToFitAsync(
      msgs,
      80,
      async () => {
        throw new Error("summary failed");
      },
      { recentMessageCount: 3 },
    );
    const nonNoticeMessages = result.messages.filter(
      (m) => m.role !== "system",
    );

    expect(result.wasTruncated).toBe(true);
    expect(result.compressionStage).toBe("safe-truncation");
    expect(nonNoticeMessages).toEqual(recent);
    expect(estimateTokens(result.messages)).toBeLessThanOrEqual(80);
  });
});
