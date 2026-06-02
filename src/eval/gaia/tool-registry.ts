/**
 * Eval 模式的 `ToolRegistry` 构造器。
 *
 * 生产环境的 `buildAgentToolRegistry` 会引入与 IPC 耦合的部分
 * (`WebContents`、`ciWatcher`、`askClarification` 等),并注册仅限
 * Electron 的工具(`webFetchRendered`、`browserOpen` 等)。CLI harness
 * 完全不需要这些 —— 它作为一个不挂接渲染进程的纯 Node 进程运行。
 *
 * 我们刻意只注册一个足够应对 GAIA L1/L2 文件 + web + 工具使用类
 * 题目的窄子集:
 *
 *   - 文件工具(read/write/list/move/delete/runCommand/...)
 *   - webFetch(始终注册 —— 仅需 `fetch`)
 *   - webSearch(当设置了 `TAVILY_API_KEY` 时)
 *   - webScrape(当设置了 `FIRECRAWL_API_KEY` 时)
 *   - youtubeTranscript(始终注册 —— 无需鉴权)
 *   - Skills(pdf / docx / xlsx / pptx)—— 从 `skills[].tools` 扁平化而来
 *
 * v1 不支持:交互式浏览器工具(需要 Electron)、GitHub / GitLab
 * 工具(需要工作区 SCM)、`askClarification`(需要 IPC 发送方)。
 * 需要其中之一的题目会在失败汇总中被标记。
 *
 * 带有 `safety: "destructive"` 的工具(writeFile、runCommand 等)在
 * eval 模式下无条件运行。尤其是 `runCommand`,L1 计算类题目需要它;
 * 若将其门控在用户审批之上,将违背自主基准测试的初衷。
 */

import type { Tool } from "ai";
import { z } from "zod/v4";

import {
  type ToolDefinition,
  ToolRegistry,
} from "../../main/core/agent/tool-registry";
import { buildFileTools } from "../../main/core/agent/tools";
import { buildWebFetchTool } from "../../main/core/agent/tools/web-fetch";
import { buildWebScrapeTool } from "../../main/core/agent/tools/web-scrape";
import { buildWebSearchTool } from "../../main/core/agent/tools/web-search";
import { buildYoutubeTranscriptTool } from "../../main/core/agent/tools/youtube-transcript";
import type { Workspace } from "../../main/core/workspace/types";
import { skills } from "../../main/skills";

export interface BuildEvalRegistryOptions {
  /** 普通的 `fetch` —— 感知代理的 fetch 仅限渲染进程作用域。 */
  fetchImpl: typeof fetch;
  /** 从环境变量读取:`process.env.TAVILY_API_KEY`。 */
  tavilyKey?: string | null;
  /** 从环境变量读取:`process.env.FIRECRAWL_API_KEY`。 */
  firecrawlKey?: string | null;
}

// ─── 工具结果大小上限 ────────────────────────────────────────────

/**
 * 任一单个工具结果序列化为 JSON 后的最大字节数。超过此值时,
 * 过长的字符串字段会被逐个截断。
 *
 * 原因:一次返回 200KB markdown 的 webFetch,在 12 轮中反复回放,
 * 就是 2.4MB 的输入 token。首次 GAIA 冒烟测试正是因为这个原因,
 * 在单道卡住的题目上消耗了 900 万输入 token。对每个结果设上限,
 * 可将最坏情况限制在数百 KB 的对话历史之内。
 */
const TOOL_RESULT_CAP_BYTES = 30_000;
/** 当结果超出上限时,单个字符串会被裁剪到此长度。 */
const STRING_LEAF_CAP_BYTES = 8_000;

const TRUNCATED_SUFFIX = (orig: number): string =>
  `\n\n...(truncated, ${orig - STRING_LEAF_CAP_BYTES} more bytes — request a narrower slice if you need them)`;

const capStringsInValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.length > STRING_LEAF_CAP_BYTES
      ? value.slice(0, STRING_LEAF_CAP_BYTES) + TRUNCATED_SUFFIX(value.length)
      : value;
  }
  if (Array.isArray(value)) return value.map(capStringsInValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = capStringsInValue(v);
    }
    return out;
  }
  return value;
};

/**
 * 对工具结果设上限:结果较小时返回原值,序列化后的大小超过上限时
 * 返回一个深拷贝并截断后的版本。即便走到超限路径,短于
 * {@link STRING_LEAF_CAP_BYTES} 的字符串也会原样透传 —— 只有过长的
 * 才会被裁剪。
 *
 * 导出供单元测试使用。
 */
export const capToolResult = (result: unknown): unknown => {
  if (typeof result === "string") {
    return result.length > TOOL_RESULT_CAP_BYTES
      ? result.slice(0, TOOL_RESULT_CAP_BYTES) +
          `\n\n...(truncated, ${result.length - TOOL_RESULT_CAP_BYTES} more bytes)`
      : result;
  }
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(result);
  } catch {
    return result;
  }
  // 对 `undefined` 和函数,JSON.stringify 返回 `undefined` ——
  // 两者都是终止值且远低于上限。
  if (serialised === undefined || serialised.length <= TOOL_RESULT_CAP_BYTES) {
    return result;
  }
  return capStringsInValue(result);
};

const wrapWithResultCap = (def: ToolDefinition): ToolDefinition => ({
  ...def,
  execute: async (args, ctx) => {
    const result = await def.execute(args, ctx);
    return capToolResult(result);
  },
});

/**
 * 将 skill 的松散形态工具(类型为 ai-sdk 的 `Tool`)包装成我们的
 * `ToolDefinition` 形态,使其能与核心工具一同加入 registry。Skill
 * 工具始终被视为 `safe`;其内部已通过内嵌的 Zod schema 校验输入。
 */
const adaptSkillTool = (name: string, tool: Tool): ToolDefinition => ({
  name,
  description: typeof tool.description === "string" ? tool.description : name,
  safety: "safe",
  inputSchema: (tool.inputSchema ?? z.object({})) as z.ZodType<unknown>,
  execute: async (args) => {
    const t = tool as {
      execute?: (args: unknown, ctx?: unknown) => unknown | Promise<unknown>;
    };
    if (!t.execute) {
      throw new Error(`Skill tool "${name}" has no execute()`);
    }
    return await t.execute(args, undefined);
  },
});

export const buildEvalToolRegistry = (
  opts: BuildEvalRegistryOptions,
): ToolRegistry => {
  const registry = new ToolRegistry();
  const register = (def: ToolDefinition): void => {
    registry.register(wrapWithResultCap(def));
  };

  // 核心文件工具 —— 不带扫描器;每道题的 eval 工作区都很小。
  for (const def of buildFileTools()) register(def);

  // Web 工具栈(仅限渲染进程的那些会被跳过)。
  register(buildWebFetchTool({ fetchImpl: opts.fetchImpl }));
  register(buildYoutubeTranscriptTool({ fetchImpl: opts.fetchImpl }));

  if (opts.tavilyKey) {
    register(
      buildWebSearchTool({
        fetchImpl: opts.fetchImpl,
        resolveTavilyToken: async () => opts.tavilyKey ?? null,
      }),
    );
  }
  if (opts.firecrawlKey) {
    register(
      buildWebScrapeTool({
        fetchImpl: opts.fetchImpl,
        resolveFirecrawlToken: async () => opts.firecrawlKey ?? null,
      }),
    );
  }

  // Skill 工具 —— 始终包含所有内置工具(pdf/docx/xlsx/pptx,以及
  // report-generator 这类分析型工具)。由模型自行挑选相关者。
  const seen = new Set(registry.list().map((d) => d.name));
  for (const skill of skills) {
    if (!skill.tools) continue;
    for (const [name, tool] of Object.entries(skill.tools)) {
      if (seen.has(name)) continue;
      register(adaptSkillTool(name, tool));
      seen.add(name);
    }
  }

  return registry;
};

/**
 * 为 registry 构造一个 `ToolContext` 工厂。导出它,使 `runner.ts`
 * 无需直接依赖 Workspace 的导入路径即可接线。
 */
export const evalContextFactory =
  (workspace: Workspace, signal: AbortSignal) =>
  (call: { toolName: string; toolCallId: string }) => ({
    workspace,
    signal,
    toolCallId: call.toolCallId,
  });
