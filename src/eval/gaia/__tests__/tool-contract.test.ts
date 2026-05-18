/**
 * Contract tests for the eval-mode tool registry.
 *
 * Builds `buildEvalToolRegistry` with mock dependencies and asserts the
 * shape — which tools register, what their schemas accept, that
 * conditional tools respect their feature flags. LLM-free, no real I/O.
 *
 * Why this exists: before this file, the eval registry assembly had
 * zero coverage (only `capToolResult` was tested). A skill renaming a
 * tool or a new build dropping `webFetch` could ship without anything
 * catching it until a real GAIA run failed.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";

import { buildEvalToolRegistry } from "../tool-registry";

// Sentinel — every test that runs registry.toAiSdkTools needs a stub
// fetchImpl; we never let a test actually hit the network.
const mockFetch: typeof fetch = async () => {
  throw new Error("network access not permitted in contract tests");
};

// ─── Required tool names ─────────────────────────────────────────────

/**
 * Tools the eval harness MUST register unconditionally. Adding/removing
 * a tool here is a deliberate signal — if you touch a name on this list,
 * also update `docs/gaia.md`'s "工具子集" section.
 */
const REQUIRED_TOOLS: readonly string[] = [
  // File ops
  "listDirectory",
  "readFile",
  "writeFile",
  "createDirectory",
  "moveFile",
  "deleteFile",
  "runCommand",
  "directoryStats",
  // Web (always-on)
  "webFetch",
  "youtubeTranscript",
  // Skills (built-in document parsers) — exact names as registered by
  // src/main/skills/*.ts. NB: runner.ts's system prompt at L141 still
  // mentions `readXlsxSheet`, but the actual xlsx tools are
  // `listSheets` + `readSheet`. That drift is a separate bug.
  "readPdfText",
  "readDocxText",
  "listSheets",
  "readSheet",
  "readPptxSlides",
];

/**
 * Tools that only register when an API key is configured. Driven by the
 * `tavilyKey` / `firecrawlKey` flags in `BuildEvalRegistryOptions`.
 */
const CONDITIONAL_TOOLS = {
  tavilyKey: "webSearch",
  firecrawlKey: "webScrape",
} as const;

// ─── Registry assembly ───────────────────────────────────────────────

describe("buildEvalToolRegistry — required tools", () => {
  const registry = buildEvalToolRegistry({ fetchImpl: mockFetch });
  const names = new Set(registry.list().map((d) => d.name));

  for (const name of REQUIRED_TOOLS) {
    it(`registers \`${name}\``, () => {
      expect(names.has(name)).toBe(true);
    });
  }

  it("registers every tool with a non-empty description", () => {
    for (const def of registry.list()) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it("registers every tool with a Zod input schema", () => {
    for (const def of registry.list()) {
      const schema = def.inputSchema as z.ZodType<unknown> & {
        safeParse?: unknown;
      };
      expect(schema).toBeDefined();
      expect(typeof schema.safeParse).toBe("function");
    }
  });

  it("does not double-register the same tool name", () => {
    const all = registry.list().map((d) => d.name);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("buildEvalToolRegistry — conditional registration", () => {
  it("omits webSearch when TAVILY key is absent", () => {
    const r = buildEvalToolRegistry({ fetchImpl: mockFetch });
    expect(r.has(CONDITIONAL_TOOLS.tavilyKey)).toBe(false);
  });

  it("omits webScrape when FIRECRAWL key is absent", () => {
    const r = buildEvalToolRegistry({ fetchImpl: mockFetch });
    expect(r.has(CONDITIONAL_TOOLS.firecrawlKey)).toBe(false);
  });

  it("registers webSearch when TAVILY key is set", () => {
    const r = buildEvalToolRegistry({
      fetchImpl: mockFetch,
      tavilyKey: "tvly-FAKE",
    });
    expect(r.has(CONDITIONAL_TOOLS.tavilyKey)).toBe(true);
  });

  it("registers webScrape when FIRECRAWL key is set", () => {
    const r = buildEvalToolRegistry({
      fetchImpl: mockFetch,
      firecrawlKey: "fc-FAKE",
    });
    expect(r.has(CONDITIONAL_TOOLS.firecrawlKey)).toBe(true);
  });

  it("treats empty string and null as 'no key'", () => {
    const r = buildEvalToolRegistry({
      fetchImpl: mockFetch,
      tavilyKey: "",
      firecrawlKey: null,
    });
    expect(r.has(CONDITIONAL_TOOLS.tavilyKey)).toBe(false);
    expect(r.has(CONDITIONAL_TOOLS.firecrawlKey)).toBe(false);
  });
});

// ─── Per-tool schema fixtures ────────────────────────────────────────

/**
 * For a small set of high-value tools, exercise the input schema with
 * one valid sample and one invalid sample. Catches schema breakage
 * without spinning up a workspace.
 */
const SCHEMA_FIXTURES: ReadonlyArray<{
  name: string;
  valid: unknown;
  invalid: unknown;
}> = [
  {
    name: "readFile",
    valid: { path: "notes.md" },
    invalid: { path: 42 },
  },
  {
    name: "listDirectory",
    valid: { path: "." },
    invalid: { path: null },
  },
  {
    name: "writeFile",
    valid: { path: "out.txt", content: "hello" },
    invalid: { path: "out.txt" },
  },
  {
    name: "runCommand",
    valid: { command: "echo hello" },
    invalid: { command: 123 },
  },
  {
    name: "webFetch",
    valid: { url: "https://example.com" },
    invalid: { url: "" },
  },
  {
    name: "youtubeTranscript",
    valid: { url: "https://youtu.be/abc123" },
    invalid: {},
  },
  {
    name: "readPdfText",
    valid: { path: "doc.pdf" },
    invalid: { path: 0 },
  },
  {
    name: "readSheet",
    valid: { path: "book.xlsx", sheet: "Sheet1" },
    // `sheet` is optional in the schema; only `path` is required.
    invalid: { sheet: "Sheet1" },
  },
];

describe("tool input schemas — sample inputs", () => {
  const registry = buildEvalToolRegistry({
    fetchImpl: mockFetch,
    tavilyKey: "tvly-FAKE",
    firecrawlKey: "fc-FAKE",
  });

  for (const { name, valid, invalid } of SCHEMA_FIXTURES) {
    it(`\`${name}\` accepts a sane input and rejects a malformed one`, () => {
      const def = registry.get(name);
      expect(def, `tool ${name} not registered`).toBeDefined();
      if (!def) return;
      const schema = def.inputSchema;
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse(invalid).success).toBe(false);
    });
  }
});

// ─── ai-sdk export ───────────────────────────────────────────────────

describe("buildEvalToolRegistry — ai-sdk export", () => {
  it("exposes every registered tool through toAiSdkTools()", () => {
    const registry = buildEvalToolRegistry({
      fetchImpl: mockFetch,
      tavilyKey: "tvly-FAKE",
      firecrawlKey: "fc-FAKE",
    });
    const aiTools = registry.toAiSdkTools({
      ctxFactory: () => {
        throw new Error("ctx not needed for export test");
      },
    });
    const exported = new Set(Object.keys(aiTools));
    for (const def of registry.list()) {
      expect(exported.has(def.name)).toBe(true);
    }
  });
});
