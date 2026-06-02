/**
 * eval 模式工具注册表的契约测试。
 *
 * 使用 mock 依赖构建 `buildEvalToolRegistry`,并断言其形态 ——
 * 哪些工具会注册、它们的 schema 接受什么、以及条件工具是否
 * 遵守各自的 feature flag。无需 LLM,不进行真实 I/O。
 *
 * 存在意义:在本文件之前,eval 注册表的组装毫无测试覆盖
 *(仅 `capToolResult` 有测试)。某个 skill 重命名工具,或某次
 * 新构建漏掉 `webFetch`,都可能直接发布,直到一次真实的 GAIA
 * 运行失败才会被发现。
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";

import { buildEvalToolRegistry } from "../tool-registry";

// 哨兵 —— 每个运行 registry.toAiSdkTools 的测试都需要一个桩
// fetchImpl;我们绝不让任何测试真正访问网络。
const mockFetch: typeof fetch = async () => {
  throw new Error("network access not permitted in contract tests");
};

// ─── 必需的工具名 ─────────────────────────────────────────────

/**
 * eval 框架必须无条件注册的工具。在此处增删工具是一个有意为之的
 * 信号 —— 如果你改动了此列表中的某个名字,
 * 也请同步更新 `docs/gaia.md` 的「工具子集」一节。
 */
const REQUIRED_TOOLS: readonly string[] = [
  // 文件操作
  "listDirectory",
  "readFile",
  "writeFile",
  "createDirectory",
  "moveFile",
  "deleteFile",
  "runCommand",
  "directoryStats",
  // Web(始终开启)
  "webFetch",
  "youtubeTranscript",
  // Skills(内置文档解析器)—— 名称与 src/main/skills/*.ts 注册的
  // 完全一致。注意:runner.ts 在 L141 的系统提示中仍提到
  // `readXlsxSheet`,但实际的 xlsx 工具是
  // `listSheets` + `readSheet`。该漂移是一个独立的 bug。
  "readPdfText",
  "readDocxText",
  "listSheets",
  "readSheet",
  "readPptxSlides",
];

/**
 * 仅在配置了 API key 时才注册的工具。由 `BuildEvalRegistryOptions`
 * 中的 `tavilyKey` / `firecrawlKey` 标志驱动。
 */
const CONDITIONAL_TOOLS = {
  tavilyKey: "webSearch",
  firecrawlKey: "webScrape",
} as const;

// ─── 注册表组装 ───────────────────────────────────────────────

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

// ─── 各工具的 schema fixture ────────────────────────────────────────

/**
 * 针对一小组高价值工具,用一个合法样本和一个非法样本来检验其
 * 输入 schema。无需启动工作区即可捕获 schema 破坏。
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
    // `sheet` 在 schema 中是可选的;只有 `path` 是必需的。
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

// ─── ai-sdk 导出 ───────────────────────────────────────────────────

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
