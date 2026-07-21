import { describe, expect, it } from "vitest";

import { ResearchLoopGuard } from "../research-loop-guard";

const call = (toolName: string, args: unknown, index: number) => ({
  toolName,
  toolCallId: `${toolName}-${index}`,
  args,
});

describe("ResearchLoopGuard", () => {
  it("moves from discovery to verification after two searches cover enough distinct sources", () => {
    const guard = new ResearchLoopGuard();

    expect(
      guard.beforeToolCall(call("webSearch", { query: "Svelte stores" }, 1)),
    ).toEqual({ allow: true });
    guard.observeToolResult({
      ...call("webSearch", { query: "Svelte stores" }, 1),
      rawOutput: {
        results: [
          { url: "https://svelte.dev/docs/svelte/stores" },
          { url: "https://svelte.dev/docs/svelte/svelte-store" },
          { url: "https://github.com/pmndrs/zustand" },
        ],
      },
    });
    expect(
      guard.beforeToolCall(
        call("webSearch", { query: "Svelte state libraries" }, 2),
      ),
    ).toEqual({ allow: true });
    guard.observeToolResult({
      ...call("webSearch", { query: "Svelte state libraries" }, 2),
      rawOutput: {
        results: [
          { url: "https://svelte.dev/docs/svelte/context" },
          { url: "https://github.com/square/svelte-store" },
          { url: "https://www.npmjs.com/package/nanostores" },
        ],
      },
    });

    expect(guard.getPhase()).toBe("verification");
    expect(
      guard.getStepPolicy([
        "webSearch",
        "webFetch",
        "webFetchRendered",
        "submitSubagentResult",
      ]),
    ).toMatchObject({
      activeTools: [
        "webSearch",
        "webFetch",
        "webFetchRendered",
        "submitSubagentResult",
      ],
      toolChoice: "auto",
      message: expect.stringMatching(/verify|source/i),
    });
  });

  it("keeps discovering when many candidate URLs all come from one host", () => {
    const guard = new ResearchLoopGuard();

    for (let index = 1; index <= 2; index++) {
      const toolCall = call(
        "webSearch",
        { query: `Svelte official docs section ${index}` },
        index,
      );
      expect(guard.beforeToolCall(toolCall)).toEqual({ allow: true });
      guard.observeToolResult({
        ...toolCall,
        rawOutput: {
          results: [1, 2, 3].map((page) => ({
            url: `https://svelte.dev/docs/page-${index}-${page}`,
          })),
        },
      });
    }

    expect(guard.getPhase()).toBe("discovery");
  });

  it("moves to forced finalization after three distinct sources were fetched", () => {
    const guard = new ResearchLoopGuard();

    for (let index = 1; index <= 3; index++) {
      const toolCall = call(
        "webFetch",
        { url: `https://example.com/source-${index}` },
        index,
      );
      expect(guard.beforeToolCall(toolCall)).toEqual({ allow: true });
      guard.observeToolResult({
        ...toolCall,
        rawOutput: { markdown: `verified source ${index} `.repeat(12) },
      });
    }

    expect(guard.getPhase()).toBe("finalization");
    expect(
      guard.getStepPolicy(["webSearch", "webFetch", "submitSubagentResult"]),
    ).toEqual({
      activeTools: ["webSearch", "webFetch", "submitSubagentResult"],
      toolChoice: { type: "tool", toolName: "submitSubagentResult" },
      message: expect.stringMatching(/submitSubagentResult|finalize/i),
    });
    expect(
      guard.beforeToolCall(
        call("webFetch", { url: "https://example.com/stale" }, 4),
      ),
    ).toMatchObject({
      allow: false,
      result: {
        success: true,
        skipped: true,
        nextAction: "submit_result",
      },
    });
  });

  it("does not count an empty fetched page as verified evidence", () => {
    const guard = new ResearchLoopGuard();
    const outputs = [
      { markdown: "verified source one ".repeat(12) },
      { markdown: "", raw: "" },
      { markdown: "verified source three ".repeat(12) },
    ];

    for (const [offset, rawOutput] of outputs.entries()) {
      const index = offset + 1;
      const toolCall = call(
        "webFetch",
        { url: `https://example.com/source-${index}` },
        index,
      );
      expect(guard.beforeToolCall(toolCall)).toEqual({ allow: true });
      guard.observeToolResult({ ...toolCall, rawOutput });
    }

    expect(guard.getPhase()).not.toBe("finalization");
  });

  it("does not count an HTTP error page as verified evidence", () => {
    const guard = new ResearchLoopGuard();
    const outputs = [
      { status: 200, markdown: "verified source one ".repeat(12) },
      { status: 404, markdown: "generic not found page ".repeat(12) },
      { status: 200, markdown: "verified source three ".repeat(12) },
    ];

    for (const [offset, rawOutput] of outputs.entries()) {
      const index = offset + 1;
      const toolCall = call(
        "webFetch",
        { url: `https://example.com/status-${index}` },
        index,
      );
      expect(guard.beforeToolCall(toolCall)).toEqual({ allow: true });
      guard.observeToolResult({ ...toolCall, rawOutput });
    }

    expect(guard.getPhase()).not.toBe("finalization");
  });

  it("turns a stale research call into a successful phase-transition result", () => {
    const guard = new ResearchLoopGuard({
      minSearchCallsBeforeVerification: 1,
      minDiscoveredSourcesBeforeVerification: 1,
      minDiscoveredSourceHostsBeforeVerification: 1,
    });
    const first = call("webSearch", { query: "Svelte stores" }, 1);
    expect(guard.beforeToolCall(first)).toEqual({ allow: true });
    guard.observeToolResult({
      ...first,
      rawOutput: {
        results: [{ url: "https://svelte.dev/docs/svelte/stores" }],
      },
    });

    expect(
      guard.beforeToolCall(call("webSearch", { query: "another search" }, 2)),
    ).toMatchObject({
      allow: false,
      result: {
        success: true,
        skipped: true,
        nextAction: "verify_sources",
      },
    });
  });
});
