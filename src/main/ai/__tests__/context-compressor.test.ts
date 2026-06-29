import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compressContext } from "../context-compressor";

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
        budget: 20,
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
        budget: 20,
        force: true,
        headCount: 1,
        tailBudget: 1,
        tailMessageCount: 2,
      },
    );

    expect(result.messages).toContainEqual(recentUser);
    expect(result.messages).toContainEqual(recentAssistant);
  });
});
