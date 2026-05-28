/**
 * deepResearch —— 多跳网络检索子代理工具。
 *
 * 主 Agent 遇到需要「链式串联结论」的问题（先查 X，再用 X 查 Y；多源对比；
 * 调研并综合）时调用本工具。它把完整的多跳循环
 *   分解 → 并行搜索 → 并发抓取 → 逐页抽取压缩 → 充分性判断 → 改写再搜
 * 放进工具**内部**，主对话只收到压缩后的结论 + 引用，原始网页（每页可达 200KB
 * markdown）永远不进入主 loop 的上下文窗口 —— 对标 Claude Code 的 subagent +
 * 结果过滤模式。
 *
 * 设计要点：
 *  - 强模型受益于上下文隔离；弱模型（如 GAIA 在测的 Xiaomi MiMo）受益于这里
 *    硬编码的循环编排 —— 它只需做有界的小任务（一次分解、N 次抽取、一次合成）。
 *  - 内层 LLM 调用复用 `result-summarizer.ts` 的范式：generateText/generateObject
 *    + createTimeoutController + 失败降级，循环永不因模型畸形输出而崩溃。
 *  - 复用现有 webSearch（Tavily）/ webFetch（Readability）的 execute，不重写。
 *
 * Safety: `safe` —— 只读，与 webSearch / webFetch 同级。
 */

import crypto from "node:crypto";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { z } from "zod/v4";

import { createTimeoutController } from "../../../ai/stream-watchdog";
import type { ToolContext, ToolDefinition } from "../tool-registry";

// ---------------------------------------------------------------------------
// 依赖与常量
// ---------------------------------------------------------------------------

export interface DeepResearchDeps {
  /** 复用用户所选模型（与 result-summarizer 同一句柄）做内层分解/抽取/合成。 */
  model: LanguageModel;
  /** 透传给内层调用，使缓存/headers 行为与主 loop 一致。 */
  providerOptions?: ProviderOptions;
  /** 复用 buildWebSearchTool 产物，内部调其 .execute。 */
  webSearch: ToolDefinition;
  /** 复用 buildWebFetchTool 产物，内部调其 .execute。 */
  webFetch: ToolDefinition;
}

/** 跨所有跳的抓取总上限（封顶成本/延迟）。 */
const MAX_TOTAL_FETCHES = 12;
/** 单跳内并发抓取上限。 */
const FETCH_CONCURRENCY = 4;
/** 每条子查询取多少搜索结果。 */
const RESULTS_PER_QUERY = 4;
/** 截给逐页抽取的页面字符数上限（避免把整页喂给小模型）。 */
const PER_PAGE_EXTRACT_INPUT = 40_000;
/** 每次内层 LLM 调用的超时。 */
const INNER_CALL_TIMEOUT_MS = 30_000;
/** 最终结论的防御性字符上限（返回主 loop 必须紧凑）。 */
const MAX_FINDINGS_CHARS = 6_000;

const inputSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      "要研究的问题。适合需要多跳/多源串联的问题，例如「某公司现任 CEO 的本科母校在哪个城市」。",
    ),
  maxHops: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "最多检索轮数（默认 3）。每轮 = 一次分解 + 并行搜索 + 抓取 + 抽取。",
    ),
  maxSubQueries: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe("每轮并行发出的子查询数上限（默认 3）。"),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("时效窗口；映射到 webSearch 的 timeRange。问最新内容时用。"),
  topic: z
    .enum(["general", "news", "finance"])
    .optional()
    .describe("检索主题（默认 general）。新闻类问题用 news。"),
});

type DeepResearchInput = z.infer<typeof inputSchema>;

// 内层结构化 schema —— 扁平、最多一层嵌套，照顾弱模型的结构化输出能力。
const decomposeSchema = z.object({
  subQueries: z
    .array(z.string())
    .describe("为推进研究而发出的具体搜索查询；彼此尽量独立以便并行。"),
  sufficient: z.boolean().describe("已掌握的事实是否已足以完整回答原问题。"),
});

const extractSchema = z.object({
  relevant: z.boolean().describe("该页面是否与问题相关。"),
  facts: z
    .array(z.string())
    .describe("从页面中抽取的、有助于回答问题的具体事实（每条自包含）。"),
});

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

interface Fact {
  claim: string;
  sourceUrl: string;
  title: string;
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
}

interface WebSearchOutput {
  answer?: string | null;
  results?: SearchResultItem[];
  error?: string;
}

interface WebFetchOutput {
  url?: string;
  title?: string | null;
  excerpt?: string | null;
  markdown?: string;
  raw?: string;
  error?: string;
}

interface DeepResearchOutput {
  findings: string;
  citations: Array<{ title: string; url: string }>;
  hopsUsed: number;
  trace: Array<{
    hop: number;
    subQueries: string[];
    urlsFetched: string[];
    factCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 基于父级 ctx 派生子上下文：透传 workspace + signal，分配新 toolCallId。 */
const childCtx = (ctx: ToolContext): ToolContext => ({
  workspace: ctx.workspace,
  signal: ctx.signal,
  toolCallId: crypto.randomUUID(),
});

/** 有限并发地 map：始终最多 limit 个 worker 在跑。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * 从模型输出文本里宽容地抽出第一个**平衡**的 JSON 对象。
 *
 * 弱模型常把 JSON 包进 ``` 围栏、或前后混入解释/思维文字。这里：
 *  1. 先剥掉 ```json … ``` 围栏（若有）；
 *  2. 从第一个 `{` 起做带字符串转义感知的括号配平，取到匹配的 `}`；
 *  3. JSON.parse 该子串。任一步失败返回 undefined（交由调用方走 fallback）。
 */
function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * 结构化内层调用：用 `generateText` 取文本，宽容提取 JSON 再用 zod 校验。
 *
 * 为什么不用 `generateObject`：OpenAI 兼容提供方（如 Xiaomi MiMo 经 DeepSeek
 * 适配器）只能走「把 schema 注入 system message」的 compat 模式，弱模型常把
 * JSON 包进 ``` 围栏或混入解释文字，导致 generateObject 直接抛
 * "could not parse the response"。改为 generateText + extractJsonObject + zod
 * 校验后，容忍围栏/前后文；任一步失败回退 fallback，多跳循环永不崩溃。
 */
async function safeStructured<T>(
  deps: DeepResearchDeps,
  schema: z.ZodType<T>,
  prompt: string,
  fallback: T,
  signal: AbortSignal,
): Promise<T> {
  const { controller, cleanup } = createTimeoutController(
    INNER_CALL_TIMEOUT_MS,
    signal,
  );
  try {
    const { text } = await generateText({
      model: deps.model,
      prompt: `${prompt}\n\n只输出一个 JSON 对象，不要 markdown 围栏、不要任何解释文字。`,
      abortSignal: controller.signal,
      providerOptions: deps.providerOptions,
    });
    const parsed = schema.safeParse(extractJsonObject(text));
    if (parsed.success) return parsed.data;
    console.warn(
      "[deepResearch] 内层结构化输出校验失败，使用 fallback:",
      parsed.error.message.slice(0, 200),
    );
    return fallback;
  } catch (err) {
    console.warn(
      "[deepResearch] 内层结构化调用失败，使用 fallback:",
      err instanceof Error ? err.message : err,
    );
    return fallback;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const factsDigest = (facts: Fact[]): string =>
  facts.length === 0
    ? "（暂无）"
    : facts
        .slice(0, 40)
        .map((f, i) => `${i + 1}. ${f.claim}`)
        .join("\n");

const decomposePrompt = (
  question: string,
  facts: Fact[],
  hop: number,
  maxSubQueries: number,
): string =>
  `你在做多跳网络检索。原始问题：\n${question}\n\n` +
  `当前是第 ${hop + 1} 轮。已掌握的事实：\n${factsDigest(facts)}\n\n` +
  `请判断：现有事实是否已足以完整、准确地回答原始问题（sufficient）。` +
  `若不足，给出最多 ${maxSubQueries} 条**具体的**搜索查询（subQueries）以补齐缺口；` +
  `尽量让各条查询相互独立，以便并行检索。若已足够，subQueries 可为空。\n\n` +
  `示例输出：{"subQueries":["关键查询 1","关键查询 2"],"sufficient":false}`;

const extractPrompt = (question: string, page: WebFetchOutput): string =>
  `原始问题：\n${question}\n\n` +
  `下面是一个网页的正文。请判断它是否与问题相关（relevant），` +
  `并抽取其中**有助于回答问题的具体事实**（facts，每条自包含、含关键数字/名称/日期）。` +
  `与问题无关则 relevant=false、facts 为空。\n\n` +
  `示例输出：{"relevant":true,"facts":["事实 1（含关键数字/名称/日期）","事实 2"]}\n\n` +
  `网页标题：${page.title ?? ""}\n来源：${page.url ?? ""}\n\n正文：\n` +
  `${(page.markdown && page.markdown.length > 0 ? page.markdown : (page.raw ?? "")).slice(0, PER_PAGE_EXTRACT_INPUT)}`;

const synthesisPrompt = (question: string, facts: Fact[]): string =>
  `根据下列已核实的事实，简洁、直接地回答问题。只用这些事实，不要编造；` +
  `若事实不足以回答，明说缺口。用与问题相同的语言作答。\n\n` +
  `问题：\n${question}\n\n事实（含来源）：\n` +
  facts
    .map((f, i) => `${i + 1}. ${f.claim}　[来源: ${f.sourceUrl}]`)
    .join("\n");

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export const buildDeepResearchTool = (
  deps: DeepResearchDeps,
): ToolDefinition => ({
  name: "deepResearch",
  description:
    "Multi-hop web research — use this FIRST for any web question that needs more than one lookup to answer. " +
    "It runs a bounded internal search→fetch→extract→synthesize loop and returns ONLY compact findings plus " +
    "citations; raw pages never enter the conversation.\n" +
    "ALWAYS use deepResearch when the question: chains facts (the answer to one part feeds the next), spans " +
    "multiple sources, or asks to research / compare / synthesize / 调研 / 对比 / 综合.\n" +
    "Do NOT use for: a single already-known URL (use webFetch), or one trivial single-shot lookup (use webSearch).\n" +
    'Examples → deepResearch: "特斯拉现任 CFO 的本科母校在哪个城市"; "对比三个向量数据库并推荐一个"; ' +
    '"who succeeded the person who founded company X, and where are they based".\n' +
    'Examples → NOT deepResearch: "总结 https://example.com/post 这一页" (webFetch); "Python 的 GIL 是什么" ' +
    '(answer directly); "今天的 AI 新闻" (webSearch).',
  safety: "safe",
  inputSchema,
  execute: async (args, ctx): Promise<DeepResearchOutput> => {
    const {
      question,
      maxHops = 3,
      maxSubQueries = 3,
      recency,
      topic,
    } = args as DeepResearchInput;

    const visited = new Set<string>();
    const facts: Fact[] = [];
    const citations = new Map<string, string>(); // url -> title
    const trace: DeepResearchOutput["trace"] = [];
    let totalFetches = 0;
    let hopsUsed = 0;

    const finish = async (): Promise<DeepResearchOutput> => {
      const citationList = Array.from(citations.entries()).map(
        ([url, title]) => ({ url, title }),
      );
      if (facts.length === 0) {
        return {
          findings:
            "未能检索到与问题相关的可靠信息。可尝试缩小问题范围或更换关键词。",
          citations: citationList,
          hopsUsed,
          trace,
        };
      }
      let findings: string;
      const { controller, cleanup } = createTimeoutController(
        INNER_CALL_TIMEOUT_MS,
        ctx.signal,
      );
      try {
        const { text } = await generateText({
          model: deps.model,
          prompt: synthesisPrompt(question, facts),
          abortSignal: controller.signal,
          providerOptions: deps.providerOptions,
        });
        findings = text;
      } catch (err) {
        // 合成失败兜底：直接列出事实，仍是有用的紧凑结论。
        console.warn(
          "[deepResearch] synthesis failed, falling back to fact list:",
          err instanceof Error ? err.message : err,
        );
        findings = facts.map((f) => `- ${f.claim}`).join("\n");
      } finally {
        cleanup();
      }
      return {
        findings: findings.slice(0, MAX_FINDINGS_CHARS),
        citations: citationList,
        hopsUsed,
        trace,
      };
    };

    if (ctx.signal.aborted) return finish();

    for (let hop = 0; hop < maxHops; hop++) {
      if (ctx.signal.aborted) break;
      hopsUsed = hop + 1;

      // (a) 分解 + 充分性判断。第 0 轮强制继续（至少搜一次）。
      const decomp = await safeStructured(
        deps,
        decomposeSchema,
        decomposePrompt(question, facts, hop, maxSubQueries),
        { subQueries: [question], sufficient: false },
        ctx.signal,
      );
      if (decomp.sufficient && hop > 0) break;
      const subQueries = (
        decomp.subQueries.length > 0 ? decomp.subQueries : [question]
      ).slice(0, maxSubQueries);

      // (b) 并行搜索：独立子查询 fan-out。
      const searches = (await Promise.all(
        subQueries.map((query) =>
          deps.webSearch
            .execute(
              {
                query,
                maxResults: RESULTS_PER_QUERY,
                includeAnswer: true,
                ...(recency ? { timeRange: recency } : {}),
                ...(topic ? { topic } : {}),
              },
              childCtx(ctx),
            )
            .catch(
              (err): WebSearchOutput => ({
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
        ),
      )) as WebSearchOutput[];

      // (c) 汇总 + 按分数排序 + 去重 URL，受抓取总预算约束。
      const remaining = MAX_TOTAL_FETCHES - totalFetches;
      const ranked = searches
        .flatMap((s) => s.results ?? [])
        .filter((r) => r.url && !visited.has(r.url))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const seenThisHop = new Set<string>();
      const toFetch: SearchResultItem[] = [];
      for (const r of ranked) {
        if (toFetch.length >= remaining) break;
        if (seenThisHop.has(r.url)) continue;
        seenThisHop.add(r.url);
        toFetch.push(r);
      }

      // (d) 并发抓取（限流）。
      const pages = (await mapWithConcurrency(
        toFetch,
        FETCH_CONCURRENCY,
        (r) =>
          deps.webFetch.execute({ url: r.url }, childCtx(ctx)).catch(
            (err): WebFetchOutput => ({
              url: r.url,
              error: err instanceof Error ? err.message : String(err),
            }),
          ) as Promise<WebFetchOutput>,
      )) as WebFetchOutput[];
      for (const r of toFetch) visited.add(r.url);
      totalFetches += pages.length;

      // (e) 逐页抽取 → 事实（压缩；主 loop 永不见原页）。
      let hopFactCount = 0;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const url = page.url ?? toFetch[i]?.url ?? "";
        if (page.error || (!page.markdown && !page.raw)) continue;
        const title = page.title ?? toFetch[i]?.title ?? url;
        const ext = await safeStructured(
          deps,
          extractSchema,
          extractPrompt(question, page),
          // 抽取失败兜底：保留 excerpt 当作单条事实，不丢线索。
          {
            relevant: Boolean(page.excerpt),
            facts: page.excerpt ? [page.excerpt] : [],
          },
          ctx.signal,
        );
        if (!ext.relevant || ext.facts.length === 0) continue;
        citations.set(url, title);
        for (const claim of ext.facts) {
          facts.push({ claim, sourceUrl: url, title });
          hopFactCount++;
        }
      }

      trace.push({
        hop,
        subQueries,
        urlsFetched: toFetch.map((r) => r.url),
        factCount: hopFactCount,
      });

      if (totalFetches >= MAX_TOTAL_FETCHES) break;
    }

    return finish();
  },
});
