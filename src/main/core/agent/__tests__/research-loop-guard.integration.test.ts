import { isStepCount, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { ResearchLoopGuard } from "../research-loop-guard";
import { ToolRegistry } from "../tool-registry";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: 0,
  },
};

describe("ResearchLoopGuard AI SDK integration", () => {
  it("turns a stale search after phase transition into a skipped result", async () => {
    const guard = new ResearchLoopGuard({
      minSearchCallsBeforeVerification: 1,
      minDiscoveredSourcesBeforeVerification: 1,
      minDiscoveredSourceHostsBeforeVerification: 1,
    });
    const discoveryCall = {
      toolName: "webSearch",
      toolCallId: "discovery-1",
      args: { query: "Svelte stores" },
    };
    expect(guard.beforeToolCall(discoveryCall)).toEqual({ allow: true });
    guard.observeToolResult({
      ...discoveryCall,
      rawOutput: {
        results: [{ url: "https://svelte.dev/docs/svelte/stores" }],
      },
    });
    expect(guard.getPhase()).toBe("verification");

    let realSearchExecutions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "webSearch",
      description: "Search the web",
      inputSchema: z.object({ query: z.string() }),
      safety: "safe",
      execute: async () => {
        realSearchExecutions++;
        return { results: [] };
      },
    });
    registry.register({
      name: "webFetch",
      description: "Fetch a web page",
      inputSchema: z.object({ url: z.string() }),
      safety: "safe",
      execute: async () => ({ status: 200, markdown: "verified" }),
    });
    registry.register({
      name: "submitSubagentResult",
      description: "Submit the result",
      inputSchema: z.object({ status: z.string() }),
      safety: "safe",
      execute: async () => ({ success: true }),
    });

    const signal = new AbortController().signal;
    const tools = registry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace: {} as never,
        signal,
        toolCallId,
      }),
      beforeAnyToolCall: async (call) => guard.beforeToolCall(call),
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "stale-search-1",
              toolName: "webSearch",
              input: JSON.stringify({ query: "another search" }),
            },
            {
              type: "finish" as const,
              usage,
              finishReason: {
                unified: "tool-calls" as const,
                raw: "tool_calls",
              },
            },
          ],
        }),
      }),
    });

    const result = streamText({
      model,
      tools,
      messages: [{ role: "user", content: "Verify the discovered sources" }],
      stopWhen: isStepCount(1),
      prepareStep: () => guard.getStepPolicy(Object.keys(tools)),
    });
    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts.some((part) => part.type === "tool-error")).toBe(false);
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
      toolName: "webSearch",
      output: {
        success: true,
        skipped: true,
        nextAction: "verify_sources",
      },
    });
    expect(realSearchExecutions).toBe(0);
  });
});
