import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  buildReport,
  DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS,
  DEFAULT_SUB_AGENT_RESULT_SCHEMA,
  extractJsonArtifacts,
  type SubAgentContract,
} from "../sub-agent-contract";

const baseContract = (
  overrides: Partial<SubAgentContract> = {},
): SubAgentContract => ({
  goal: "test",
  input: { prompt: "do the thing" },
  output: { format: "summary" },
  termination: {},
  ...overrides,
});

describe("buildReport", () => {
  it("uses a default cumulative token budget large enough for source exploration", () => {
    expect(DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS).toBeGreaterThanOrEqual(120_000);
  });

  it("returns precomputedSummary verbatim when supplied", () => {
    const r = buildReport({
      agentId: "a1",
      contract: baseContract(),
      status: "ok",
      finalText: "raw final text — long",
      precomputedSummary: "compressed.",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCallCount: 0,
      durationMs: 100,
    });
    expect(r.summary).toBe("compressed.");
    expect(r.status).toBe("ok");
  });

  it("trims finalText into summary when no precomputedSummary", () => {
    const r = buildReport({
      agentId: "a2",
      contract: baseContract(),
      status: "ok",
      finalText: "   hello world  ",
      usage: undefined,
      toolCallCount: 0,
      durationMs: 50,
    });
    expect(r.summary).toBe("hello world");
    expect(r.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("validates artifacts against schema for format=json", () => {
    const contract = baseContract({
      output: {
        format: "json",
        schema: z.object({ count: z.number(), label: z.string() }),
      },
    });
    const r = buildReport({
      agentId: "a3",
      contract,
      status: "ok",
      finalText: "{}",
      candidateArtifacts: { count: 7, label: "ok" },
      usage: undefined,
      toolCallCount: 1,
      durationMs: 10,
    });
    expect(r.status).toBe("ok");
    expect(r.artifacts).toEqual({ count: 7, label: "ok" });
  });

  it("downgrades to failed when format=json artifacts miss schema", () => {
    const contract = baseContract({
      output: {
        format: "json",
        schema: z.object({ count: z.number() }),
      },
    });
    const r = buildReport({
      agentId: "a4",
      contract,
      status: "ok",
      finalText: "{}",
      candidateArtifacts: { count: "seven" },
      usage: undefined,
      toolCallCount: 1,
      durationMs: 10,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/schema validation/);
    expect(r.artifacts).toBeUndefined();
  });

  it("downgrades to failed when format=json schema is omitted", () => {
    const contract = baseContract({ output: { format: "json" } });
    const r = buildReport({
      agentId: "a5",
      contract,
      status: "ok",
      finalText: "{}",
      candidateArtifacts: { any: 1 },
      usage: undefined,
      toolCallCount: 0,
      durationMs: 5,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/schema is required/);
  });

  it("downgrades to failed when format=json has no artifacts", () => {
    const contract = baseContract({
      output: { format: "json", schema: z.object({}) },
    });
    const r = buildReport({
      agentId: "a6",
      contract,
      status: "ok",
      finalText: "no json here",
      usage: undefined,
      toolCallCount: 0,
      durationMs: 5,
    });
    expect(r.status).toBe("failed");
  });

  it("passes through non-ok status unchanged", () => {
    const r = buildReport({
      agentId: "a7",
      contract: baseContract(),
      status: "timeout",
      finalText: "partial",
      usage: undefined,
      toolCallCount: 0,
      durationMs: 120_000,
      error: "wall clock exceeded",
    });
    expect(r.status).toBe("timeout");
    expect(r.error).toBe("wall clock exceeded");
  });

  it("marks truncated reports without structured findings as no_result", () => {
    const r = buildReport({
      agentId: "a7-no-result",
      contract: baseContract(),
      status: "token_limit",
      finalText: "I will inspect the directory and return a concise summary.",
      usage: undefined,
      toolCallCount: 0,
      durationMs: 10_000,
    });

    expect(r.status).toBe("token_limit");
    expect(r.resultQuality).toBe("no_result");
    expect(r.artifacts).toBeUndefined();
  });

  it("rejects truncated reports even when they submitted partial findings", () => {
    const r = buildReport({
      agentId: "a7-partial",
      contract: baseContract({
        output: { format: "json", schema: DEFAULT_SUB_AGENT_RESULT_SCHEMA },
      }),
      status: "token_limit",
      finalText: "{}",
      candidateArtifacts: {
        status: "partial",
        coverage: ["src/main/ipc"],
        findings: [
          {
            claim: "IPC owns process boundaries.",
            evidence: ["src/main/ipc/index.ts"],
          },
        ],
        missing: ["Did not inspect renderer consumers."],
        failureReason: "Token budget reached after enough evidence.",
      },
      usage: undefined,
      toolCallCount: 3,
      durationMs: 60_000,
    });

    expect(r.status).toBe("token_limit");
    expect(r.resultQuality).toBe("no_result");
    expect(r.artifacts).toMatchObject({
      status: "partial",
      coverage: ["src/main/ipc"],
    });
  });

  it("rejects partial default artifacts for ok runs", () => {
    const r = buildReport({
      agentId: "a7-ok-partial",
      contract: baseContract({
        output: { format: "json", schema: DEFAULT_SUB_AGENT_RESULT_SCHEMA },
      }),
      status: "ok",
      finalText: "{}",
      candidateArtifacts: {
        status: "partial",
        coverage: ["src/main/ipc"],
        findings: [
          {
            claim: "IPC owns process boundaries.",
            evidence: ["src/main/ipc/index.ts"],
          },
        ],
        missing: ["Did not inspect renderer consumers."],
        failureReason: null,
      },
      usage: undefined,
      toolCallCount: 3,
      durationMs: 60_000,
    });

    expect(r.status).toBe("ok");
    expect(r.resultQuality).toBe("no_result");
    expect(r.artifacts).toMatchObject({ status: "partial" });
  });

  it("rejects default result artifacts for truncated non-json outputs", () => {
    const r = buildReport({
      agentId: "a7-summary-partial",
      contract: baseContract({ output: { format: "summary" } }),
      status: "timeout",
      finalText: "Partial answer plus RESULT_JSON",
      candidateArtifacts: {
        status: "partial",
        coverage: ["docs/spec.md"],
        findings: [
          {
            claim: "The spec requires bounded subagent evidence.",
            evidence: ["docs/spec.md"],
          },
        ],
        missing: [],
      },
      usage: undefined,
      toolCallCount: 1,
      durationMs: 5000,
    });

    expect(r.status).toBe("timeout");
    expect(r.resultQuality).toBe("no_result");
    expect(r.artifacts).toMatchObject({ status: "partial" });
  });

  it("preserves artifacts for non-json formats without validating", () => {
    const r = buildReport({
      agentId: "a8",
      contract: baseContract({ output: { format: "patch" } }),
      status: "ok",
      finalText: "applied",
      candidateArtifacts: { diff: "anything goes" },
      usage: undefined,
      toolCallCount: 0,
      durationMs: 10,
    });
    expect(r.artifacts).toEqual({ diff: "anything goes" });
  });
});

describe("extractJsonArtifacts", () => {
  it("prefers fenced ```json block", () => {
    const txt = 'prose\n```json\n{"a":1}\n```\ntrailing';
    expect(extractJsonArtifacts(txt)).toEqual({ a: 1 });
  });

  it("falls back to outermost balanced object literal", () => {
    const txt = 'preamble {"a":1,"b":{"c":2}} suffix';
    expect(extractJsonArtifacts(txt)).toEqual({ a: 1, b: { c: 2 } });
  });

  it("returns undefined when no JSON is present", () => {
    expect(
      extractJsonArtifacts("just prose, nothing structured"),
    ).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(extractJsonArtifacts("```json\n{a:1}\n```")).toBeUndefined();
  });

  it("returns undefined for top-level arrays (artifacts must be objects)", () => {
    expect(extractJsonArtifacts("[1,2,3]")).toBeUndefined();
  });

  it("handles braces inside strings without confusing depth tracking", () => {
    const txt = '{"label":"contains } brace","count":3}';
    expect(extractJsonArtifacts(txt)).toEqual({
      label: "contains } brace",
      count: 3,
    });
  });
});
