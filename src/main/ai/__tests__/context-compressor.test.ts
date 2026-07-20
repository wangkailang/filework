import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compressContext } from "../context-compressor";

const dbMock = vi.hoisted(() => ({
  replaceContextMemoryChunks: vi.fn(),
  upsertTaskSummary: vi.fn(),
}));

vi.mock("../../db", () => dbMock);

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantWithToolCall(
  toolCallId: string,
  toolName: string,
): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input: {} }],
  };
}

function toolResultMsg(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value: "tool result" },
      },
    ],
  };
}

const findToolCallIndex = (messages: ModelMessage[], toolCallId: string) =>
  messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
      ),
  );

const findToolResultIndex = (messages: ModelMessage[], toolCallId: string) =>
  messages.findIndex(
    (message) =>
      message.role === "tool" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "tool-result" && part.toolCallId === toolCallId,
      ),
  );

describe("compressContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockClear();
    vi.mocked(generateText).mockResolvedValue({
      text: "## 已完成\n- summarized earlier work",
    } as Awaited<ReturnType<typeof generateText>>);
  });

  it("keeps tool results with protected head tool calls before inserting the summary", async () => {
    const result = await compressContext(
      [
        { role: "system", content: "system prompt" },
        assistantWithToolCall("call-1", "readFile"),
        toolResultMsg("call-1", "readFile"),
        userMsg("middle content ".repeat(200)),
        userMsg("latest request"),
      ],
      {
        model: {} as LanguageModel,
        budget: 1_000,
        force: true,
        headCount: 2,
        tailBudget: 10,
        tailMessageCount: 1,
      },
    );

    const summaryIndex = result.messages.findIndex(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("summarized earlier work"),
    );
    const toolCallIndex = findToolCallIndex(result.messages, "call-1");
    const toolResultIndex = findToolResultIndex(result.messages, "call-1");

    expect(summaryIndex).toBeGreaterThan(0);
    expect(toolCallIndex).toBeGreaterThan(0);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
    expect(toolResultIndex).toBeLessThan(summaryIndex);
  });

  it("hard-retains configured tail messages even when they exceed the tail token budget", async () => {
    const recentUser = userMsg("recent user context ".repeat(120));
    const recentAssistant = userMsg("recent assistant context ".repeat(120));

    const result = await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("middle content ".repeat(300)),
        recentUser,
        recentAssistant,
      ],
      {
        model: {} as LanguageModel,
        budget: 2_000,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 2,
      },
    );

    expect(result.messages).toContainEqual(recentUser);
    expect(result.messages).toContainEqual(recentAssistant);
  });

  it("preserves the precompacted context when summarization fails", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error("summary failed"));
    const messages = [
      { role: "system" as const, content: "system prompt" },
      userMsg("middle context that must not be dropped"),
      userMsg("latest request"),
    ];

    const result = await compressContext(messages, {
      model: {} as LanguageModel,
      budget: 20,
      force: true,
      headCount: 1,
      tailBudget: 1,
      tailMessageCount: 1,
    });

    expect(result.hadError).toBe(true);
    expect(result.wasCompressed).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("persists the last summarized source message as the checkpoint watermark", async () => {
    const result = await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("old request"),
        userMsg("old answer"),
        userMsg("latest request"),
      ],
      {
        model: {} as LanguageModel,
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
        sourceMessageIds: ["m1", "m2", "m3", "m4"],
        summaryScopeId: "session:chat-1",
      },
    );

    expect(result.coveredThroughMessageId).toBe("m3");
    expect(result.retainedTailStartId).toBe("m4");
    expect(dbMock.upsertTaskSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "session:chat-1",
        coveredThroughMessageId: "m3",
        retainedTailStartId: "m4",
        summaryVersion: 1,
      }),
    );
  });

  it("does not advance the session checkpoint without stable source message ids", async () => {
    await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("runtime-only middle context"),
        userMsg("latest request"),
      ],
      {
        model: {} as LanguageModel,
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
        taskId: "task-1",
        summaryScopeId: "session:chat-1",
      },
    );

    expect(dbMock.upsertTaskSummary).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
    );
    expect(dbMock.upsertTaskSummary).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "session:chat-1" }),
    );
    expect(dbMock.replaceContextMemoryChunks).not.toHaveBeenCalledWith(
      "session:chat-1",
      expect.anything(),
    );
  });

  it("preserves the latest tool result while compacting older context", async () => {
    const latestResult = `LATEST_RESULT:${"x".repeat(3_000)}`;
    const result = await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("older middle context ".repeat(200)),
        assistantWithToolCall("call-latest", "readFile"),
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-latest",
              toolName: "readFile",
              output: { type: "text", value: latestResult },
            },
          ],
        },
      ],
      {
        model: {} as LanguageModel,
        budget: 1_000,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 2,
      },
    );

    const latestToolMessage = result.messages.findLast(
      (message) => message.role === "tool",
    );
    expect(latestToolMessage?.content).toEqual([
      expect.objectContaining({
        output: { type: "text", value: latestResult },
      }),
    ]);
  });

  it("fits a successful semantic compression result within the target budget", async () => {
    const result = await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("middle context ".repeat(400)),
        userMsg(`LATEST_REQUEST:${"x".repeat(2_000)}`),
      ],
      {
        model: {} as LanguageModel,
        budget: 120,
        force: true,
        headCount: 1,
        tailBudget: 1_000,
        tailMessageCount: 1,
      },
    );

    expect(result.hadError).toBe(false);
    expect(result.compressedTokens).toBeLessThanOrEqual(120);
    expect(JSON.stringify(result.messages)).toContain("LATEST_REQUEST");
  });

  it("includes the previous rolling summary when summarizing new middle history", async () => {
    await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("new middle work that must be merged into the summary"),
        userMsg("latest request"),
      ],
      {
        model: {} as LanguageModel,
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
        previousSummary: "## 已完成\n- previous compressed fact",
      },
    );

    const prompt = vi.mocked(generateText).mock.calls.at(-1)?.[0].prompt;
    expect(prompt).toContain("上一版滚动摘要");
    expect(prompt).toContain("previous compressed fact");
    expect(prompt).toContain("new middle work that must be merged");
  });

  it("requests an execution-ready checkpoint without persisting secrets", async () => {
    await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("implemented the auth fix and ran its regression test"),
        userMsg("continue with the remaining work"),
      ],
      {
        model: {} as LanguageModel,
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
      },
    );

    const prompt = vi.mocked(generateText).mock.calls.at(-1)?.[0].prompt;
    expect(prompt).toContain("## 当前目标");
    expect(prompt).toContain("## 用户约束");
    expect(prompt).toContain("## 关键决策与理由");
    expect(prompt).toContain("## 文件与产物");
    expect(prompt).toContain("## 验证状态");
    expect(prompt).toContain("## 失败尝试");
    expect(prompt).toContain("## 下一步");
    expect(prompt).toContain("不要记录密码、API key、访问令牌或其他凭据");
  });

  it("includes vector-recalled memory chunks when summarizing new middle history", async () => {
    await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("new token renewal work that must be merged"),
        userMsg("latest request"),
      ],
      {
        model: {} as LanguageModel,
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
        previousSummary:
          "## 已完成\n- initial setup\n- unrelated UI notes\n## 待处理\n- final cleanup",
        memoryChunks: [
          {
            text: "auth session token renewal regression memory",
            embedding: null,
          },
        ],
        recallQuery: "auth token renewal regression",
      },
    );

    const prompt = vi.mocked(generateText).mock.calls.at(-1)?.[0].prompt;
    expect(prompt).toContain("auth session token renewal regression memory");
  });

  it("uses the latest user request rather than middle history for summary recall", async () => {
    await compressContext(
      [
        { role: "system", content: "system prompt" },
        userMsg("unrelated renderer spacing notes"),
        userMsg("latest request"),
      ],
      {
        model: {} as LanguageModel,
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
        previousSummary: [
          "## 已完成",
          "- first setup fact",
          "- unrelated visual details",
          "- OAuth token renewal bug isolated in auth/session.ts",
          "## 待处理",
          "- final cleanup",
        ].join("\n"),
        recallQuery: "OAuth token renewal auth session",
      },
    );

    const prompt = vi.mocked(generateText).mock.calls.at(-1)?.[0].prompt;
    expect(prompt).toContain("OAuth token renewal bug");
  });

  it("injects the previous rolling summary when there is no new middle history", async () => {
    const result = await compressContext(
      [{ role: "system", content: "system prompt" }, userMsg("latest request")],
      {
        model: {} as LanguageModel,
        budget: 1_000,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 1,
        previousSummary: "## 已完成\n- previous compressed fact",
      },
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(result.wasCompressed).toBe(true);
    expect(
      result.messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("previous compressed fact"),
      ),
    ).toBe(true);
    expect(result.messages.at(-1)).toEqual(userMsg("latest request"));
  });
});
