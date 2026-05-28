/**
 * deepResearch 多跳子代理工具测试。
 *
 * 三个外部依赖全部注入，故循环完全可测：
 *  - mock `ai` 的 generateText（内层 LLM 调用：decompose / extract / synthesis
 *    都返回 JSON 文本，经宽容解析）。
 *  - mock webSearch / webFetch 的 execute（网络）。
 *
 * 仿 web-search.test.ts 的 fakeCtx + vi.fn 结构。
 */
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

// 与 reflection-gate.test.ts 一致：保留 ai 的真实导出，只替换 generateText。
// deepResearch 内层（含 synthesis）已统一为 generateText + 宽容 JSON 解析。
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";

import type { Workspace } from "../../workspace/types";
import type { ToolDefinition } from "../tool-registry";
import {
  buildDeepResearchTool,
  type DeepResearchDeps,
} from "../tools/deep-research";

const mockedGenText = vi.mocked(generateText);

const fakeWorkspace = (): Workspace =>
  ({
    id: "local:/tmp",
    kind: "local",
    root: "/tmp",
    fs: {} as never,
    exec: {} as never,
  }) as Workspace;

const fakeCtx = (signal?: AbortSignal) => ({
  workspace: fakeWorkspace(),
  signal: signal ?? new AbortController().signal,
  toolCallId: "t-1",
});

const model = "mock-model" as unknown as LanguageModel;

/** 把一个 execute 包成最小 ToolDefinition（deep-research 只用 .execute）。 */
const mkTool = (
  name: string,
  execute: ReturnType<typeof vi.fn>,
): ToolDefinition =>
  ({
    name,
    description: "",
    safety: "safe",
    inputSchema: z.any(),
    execute,
  }) as unknown as ToolDefinition;

const makeDeps = (
  webSearchExec: ReturnType<typeof vi.fn>,
  webFetchExec: ReturnType<typeof vi.fn>,
): DeepResearchDeps => ({
  model,
  webSearch: mkTool("webSearch", webSearchExec),
  webFetch: mkTool("webFetch", webFetchExec),
});

// decompose / extract / synthesis 内层都用 generateText，模型应返回 JSON 文本。
const jsonText = (o: unknown) => ({ text: JSON.stringify(o) }) as never;
const proseText = (t: string) => ({ text: t }) as never;
// 合成产出 { directAnswer, confidence, findings }。
const synthText = (
  directAnswer: string,
  confidence: string,
  findings: string,
) => jsonText({ directAnswer, confidence, findings });

beforeEach(() => {
  mockedGenText.mockReset();
});

describe("buildDeepResearchTool", () => {
  it("第 1 轮判定 sufficient 后停止，返回 directAnswer/confidence/findings 与引用", async () => {
    mockedGenText
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q1"], sufficient: false }),
      ) // hop0 分解
      .mockResolvedValueOnce(jsonText({ relevant: true, facts: ["fact A"] })) // 抽取 A
      .mockResolvedValueOnce(jsonText({ subQueries: [], sufficient: true })) // hop1 分解 → 停
      .mockResolvedValueOnce(synthText("Answer.", "high", "因为 A。")); // 合成

    const webSearchExec = vi.fn(async () => ({
      results: [{ title: "A", url: "https://a", snippet: "", score: 1 }],
    }));
    const webFetchExec = vi.fn(async () => ({
      url: "https://a",
      title: "A",
      markdown: "page A body",
      excerpt: "exc",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute({ question: "Q" }, fakeCtx())) as {
      directAnswer: string;
      confidence: string;
      findings: string;
      citations: Array<{ title: string; url: string }>;
      hopsUsed: number;
    };

    expect(out.directAnswer).toBe("Answer.");
    expect(out.confidence).toBe("high");
    expect(out.findings).toBe("因为 A。");
    expect(out.citations).toEqual([{ url: "https://a", title: "A" }]);
    expect(out.hopsUsed).toBe(2);
    expect(webSearchExec).toHaveBeenCalledTimes(1); // hop1 在搜索前 break
  });

  it("不充分时持续多跳，hopsUsed 反映已执行轮数", async () => {
    mockedGenText
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q1"], sufficient: false }),
      )
      .mockResolvedValueOnce(jsonText({ relevant: true, facts: ["fA"] }))
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q2"], sufficient: false }),
      )
      .mockResolvedValueOnce(jsonText({ relevant: true, facts: ["fB"] }))
      .mockResolvedValueOnce(synthText("D", "high", "Synth"));

    const webSearchExec = vi.fn(async ({ query }: { query: string }) =>
      query === "q1"
        ? { results: [{ title: "A", url: "https://a", snippet: "", score: 1 }] }
        : {
            results: [{ title: "B", url: "https://b", snippet: "", score: 1 }],
          },
    );
    const webFetchExec = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: url === "https://a" ? "A" : "B",
      markdown: "body",
      excerpt: "e",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute(
      { question: "Q", maxHops: 2 },
      fakeCtx(),
    )) as { hopsUsed: number; citations: unknown[] };

    expect(out.hopsUsed).toBe(2);
    expect(webSearchExec).toHaveBeenCalledTimes(2);
    expect(webFetchExec).toHaveBeenCalledTimes(2);
    expect(out.citations).toHaveLength(2);
  });

  it("跨子查询的同一 URL 只抓取一次（去重）", async () => {
    mockedGenText
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q1", "q2"], sufficient: false }),
      )
      .mockResolvedValueOnce(jsonText({ relevant: true, facts: ["f"] }))
      .mockResolvedValueOnce(synthText("x", "medium", "x"));

    const webSearchExec = vi.fn(async () => ({
      results: [{ title: "A", url: "https://a", snippet: "", score: 1 }],
    }));
    const webFetchExec = vi.fn(async () => ({
      url: "https://a",
      title: "A",
      markdown: "b",
      excerpt: "e",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    await tool.execute({ question: "Q", maxHops: 1 }, fakeCtx());

    expect(webSearchExec).toHaveBeenCalledTimes(2);
    expect(webFetchExec).toHaveBeenCalledTimes(1); // 同 URL 去重
  });

  it("抓取数被 MAX_TOTAL_FETCHES 钳制为 12", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `T${i}`,
      url: `https://x${i}`,
      snippet: "",
      score: 1,
    }));
    mockedGenText
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q1"], sufficient: false }),
      )
      .mockResolvedValue(jsonText({ relevant: false, facts: [] })); // 12 次抽取

    const webSearchExec = vi.fn(async () => ({ results: many }));
    const webFetchExec = vi.fn(async ({ url }: { url: string }) => ({
      url,
      markdown: "b",
      excerpt: "",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    await tool.execute(
      { question: "Q", maxHops: 1, maxSubQueries: 1 },
      fakeCtx(),
    );

    expect(webFetchExec).toHaveBeenCalledTimes(12);
  });

  it("内层调用抛错 / 输出无法解析时走降级路径，循环不崩且仍返回结论", async () => {
    mockedGenText
      .mockRejectedValueOnce(new Error("boom")) // 分解抛错 → fallback [question]
      .mockResolvedValueOnce(proseText("这不是 JSON，只是一段解释")) // 抽取解析失败 → excerpt fallback
      .mockResolvedValueOnce(synthText("", "low", "synth from fallback")); // 合成

    const webSearchExec = vi.fn(async () => ({
      results: [{ title: "A", url: "https://a", snippet: "", score: 1 }],
    }));
    const webFetchExec = vi.fn(async () => ({
      url: "https://a",
      title: "A",
      markdown: "body",
      excerpt: "EXC",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute(
      { question: "Q", maxHops: 1 },
      fakeCtx(),
    )) as { findings: string; citations: unknown[] };

    expect(out.findings).toBe("synth from fallback");
    expect(out.citations).toHaveLength(1);
  });

  it("合成输出无法解析时降级为事实列表（confidence=low）", async () => {
    mockedGenText
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q1"], sufficient: false }),
      )
      .mockResolvedValueOnce(jsonText({ relevant: true, facts: ["事实甲"] }))
      .mockResolvedValueOnce(proseText("一段无法解析为 JSON 的合成输出")); // 合成解析失败

    const webSearchExec = vi.fn(async () => ({
      results: [{ title: "A", url: "https://a", snippet: "", score: 1 }],
    }));
    const webFetchExec = vi.fn(async () => ({
      url: "https://a",
      title: "A",
      markdown: "body",
      excerpt: "e",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute(
      { question: "Q", maxHops: 1 },
      fakeCtx(),
    )) as { directAnswer: string; confidence: string; findings: string };

    expect(out.confidence).toBe("low");
    expect(out.directAnswer).toBe("");
    expect(out.findings).toContain("事实甲"); // 事实列表兜底
  });

  it("内层输出被 ```json 围栏包裹时仍能解析（弱模型常见）", async () => {
    mockedGenText
      .mockResolvedValueOnce(
        proseText(
          '这是我的判断：\n```json\n{"subQueries":["q1"],"sufficient":false}\n```',
        ),
      )
      .mockResolvedValueOnce(
        proseText('```\n{"relevant":true,"facts":["围栏里的事实"]}\n```'),
      )
      .mockResolvedValueOnce(synthText("FA", "high", "Fenced answer."));

    const webSearchExec = vi.fn(async () => ({
      results: [{ title: "A", url: "https://a", snippet: "", score: 1 }],
    }));
    const webFetchExec = vi.fn(async () => ({
      url: "https://a",
      title: "A",
      markdown: "body",
      excerpt: "e",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute(
      { question: "Q", maxHops: 1 },
      fakeCtx(),
    )) as { directAnswer: string; findings: string; citations: unknown[] };

    expect(out.directAnswer).toBe("FA");
    expect(out.findings).toBe("Fenced answer.");
    expect(out.citations).toHaveLength(1); // 围栏内 JSON 被正确解析出 fact
  });

  it("信号已 abort 时立即返回、不触达任何搜索/LLM", async () => {
    const ac = new AbortController();
    ac.abort();
    const webSearchExec = vi.fn();
    const webFetchExec = vi.fn();

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute({ question: "Q" }, fakeCtx(ac.signal))) as {
      findings: string;
      hopsUsed: number;
      confidence: string;
    };

    expect(webSearchExec).not.toHaveBeenCalled();
    expect(mockedGenText).not.toHaveBeenCalled();
    expect(out.hopsUsed).toBe(0);
    expect(out.confidence).toBe("insufficient");
    expect(out.findings).toMatch(/未能检索/);
  });

  it("结论被截断到上限，原始整页 markdown 不泄漏到返回对象", async () => {
    mockedGenText
      .mockResolvedValueOnce(
        jsonText({ subQueries: ["q1"], sufficient: false }),
      )
      .mockResolvedValueOnce(
        jsonText({ relevant: true, facts: ["short fact"] }),
      )
      .mockResolvedValueOnce(synthText("y", "high", "y".repeat(10_000)));

    const hugeMarkdown = "x".repeat(300_000);
    const webSearchExec = vi.fn(async () => ({
      results: [{ title: "A", url: "https://a", snippet: "", score: 1 }],
    }));
    const webFetchExec = vi.fn(async () => ({
      url: "https://a",
      title: "A",
      markdown: hugeMarkdown,
      excerpt: "e",
    }));

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    const out = (await tool.execute(
      { question: "Q", maxHops: 1 },
      fakeCtx(),
    )) as { findings: string };

    expect(out.findings.length).toBe(6_000); // MAX_FINDINGS_CHARS
    expect(JSON.stringify(out)).not.toContain("x".repeat(1_000));
  });

  it("同一任务调用超过 MAX_DEEP_RESEARCH_CALLS 后短路，不再检索", async () => {
    // 每次运行：decompose → 搜索空结果 → 无事实 → finish 早返回（无 synthesis）。
    mockedGenText.mockResolvedValue(
      jsonText({ subQueries: ["q"], sufficient: false }),
    );
    const webSearchExec = vi.fn(async () => ({ results: [] }));
    const webFetchExec = vi.fn();

    const tool = buildDeepResearchTool(makeDeps(webSearchExec, webFetchExec));
    await tool.execute({ question: "Q", maxHops: 1 }, fakeCtx()); // 第 1 次
    await tool.execute({ question: "Q", maxHops: 1 }, fakeCtx()); // 第 2 次
    const searchCallsBefore = webSearchExec.mock.calls.length;

    const out3 = (await tool.execute(
      { question: "Q", maxHops: 1 },
      fakeCtx(),
    )) as { confidence: string; findings: string }; // 第 3 次 → 短路

    expect(out3.confidence).toBe("insufficient");
    expect(out3.findings).toMatch(/已在本任务内调用 deepResearch/);
    // 第 3 次不应再发起任何搜索
    expect(webSearchExec.mock.calls.length).toBe(searchCallsBefore);
  });
});
