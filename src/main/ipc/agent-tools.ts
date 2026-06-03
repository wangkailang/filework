/**
 * 为 AgentLoop 路径构建按任务隔离的 `ToolRegistry`。
 *
 * 封装:
 *  - `core/agent/tools/buildFileTools` —— 8 个核心文件工具,针对传入的
 *    `Workspace` 执行(通过 realpath 检查做沙箱隔离)
 *  - `askClarification` —— 与 IPC 耦合的工具,通过 `ai:stream-clarification`
 *    暂停循环以向用户提出多选问题
 *
 * 当提供了 `allowedTools` 时(skill frontmatter 的 `allowed-tools`),
 * 仅注册名称匹配的工具。
 *
 * (截至 M2 PR 4,这是代码库中唯一的工具集构建器。
 * `ai-tool-permissions.ts` 中遗留的 `buildTools` / `buildSkillSpecificTools`
 * 已被删除;fork 模式现在也通过 `fork-skill-runner.ts` 走这套 registry。)
 */

import crypto from "node:crypto";
import type { WebContents } from "electron";
import { z } from "zod/v4";
import {
  DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS,
  DEFAULT_SUB_AGENT_MAX_TURNS,
  DEFAULT_SUB_AGENT_MAX_WALL_MS,
  type SubAgentContract,
  type SubAgentOutputFormat,
} from "../core/agent/sub-agent-contract";
import { type ToolDefinition, ToolRegistry } from "../core/agent/tool-registry";
import {
  buildFileTools,
  type IncrementalScannerLike,
  type IncrementalScanResult,
  type WorkspaceEntryLike,
} from "../core/agent/tools";
import { buildBrowserInteractiveTools } from "../core/agent/tools/browser-interactive";
import { clearMemoryTool, updateMemoryTool } from "../core/agent/tools/memory";
import { buildWebFetchTool } from "../core/agent/tools/web-fetch";
import { buildWebFetchRenderedTool } from "../core/agent/tools/web-fetch-rendered";
import { buildWebScrapeTool } from "../core/agent/tools/web-scrape";
import { buildWebSearchTool } from "../core/agent/tools/web-search";
import { buildYoutubeTranscriptTool } from "../core/agent/tools/youtube-transcript";
import { resolveSandboxConfig } from "../core/sandbox";
import { getSetting } from "../db";
import { mcpManager } from "../mcp/manager";
import { searchFiles as nativeSearchFiles } from "../native";
import { skillRegistry } from "../skills";
import { wrapWithSecurityBoundary } from "../skills-runtime";
import {
  type FileEntry,
  getIncrementalScanner,
} from "../utils/incremental-scanner";
import {
  approvedInlinePlanTasks,
  makeInlinePlanId,
  pendingClarifications,
  pendingPlanApprovals,
  registerPlanGate,
} from "./ai-task-control";
import {
  buildGitRunCommandProtocol,
  buildSubagentSystemPrompt,
} from "./system-prompt";

interface BuildAgentToolRegistryOptions {
  sender: WebContents;
  taskId: string;
  /** 设置后限定为此 allow-list(skill 的 `allowed-tools` frontmatter)。 */
  allowedTools?: string[];
  /**
   * 解析后的 LLM 标识 —— 流入 L2 git 协议的 `Co-Authored-By` trailer
   * (当 `isGitWorkspace` 为 true 时嵌入 `runCommand` 的描述)。
   * 回落为 "filework-agent"。
   */
  modelName?: string;
  /**
   * 当前工作区由 git 托管时为 true。决定是否把 L2 git 协议
   * (HEREDOC commit、`gh` / `glab` PR 模板)嵌入 `runCommand` 工具描述。
   * 原因参见 `system-prompt.buildGitRunCommandProtocol`。
   */
  isGitWorkspace?: boolean;
  /**
   * 注册 `spawnSubagent` 工具(让本 agent 能委派并行子 agent)。
   * 仅主 agent 路径应设为 true;子 agent 路径必须保持 false/缺省 ——
   * 否则子 agent 会再委派,导致递归爆炸。
   */
  enableSubagent?: boolean;
  /**
   * spawnSubagent 用:父级 abort signal。子 agent 批次级联此 signal,
   * 父级取消时所有子 agent 一并中止。enableSubagent 时必填。
   */
  parentSignal?: AbortSignal;
  /** spawnSubagent 用:解析 model/adapter 的 llmConfig id。 */
  llmConfigId?: string;
  /** spawnSubagent 用:子 agent 的工作目录(继承父级 workspace.root)。 */
  workspacePath?: string;
  /**
   * spawnSubagent 用:父 agent 当前可委派的 skill id 全集。子 agent 的
   * allowedSkills 只能是它的子集(主 agent 限制子 agent 能力的硬边界)。
   * 缺省 → 子 agent 不获注入任何 skill 描述。
   */
  parentAllowedSkills?: string[];
}

/**
 * 模块级依赖,在应用启动时注入一次(对应 `ai-handlers.ts` 中的
 * `setWorkspaceFactoryDeps`)。agent registry 构建器会被多个调用点
 * 按任务调用;把代理感知的 fetch 放在这里,避免在每个 option 包里
 * 层层传递。
 */
interface AgentRegistryDeps {
  fetchFn?: typeof fetch;
  /** 返回最近一次的 Tavily API key 或 null。决定 `webSearch` 是否可用。 */
  resolveTavilyToken?: () => Promise<string | null>;
  /** 返回最近一次的 Firecrawl API key 或 null。决定 `webScrape` 是否可用。 */
  resolveFirecrawlToken?: () => Promise<string | null>;
}
let agentRegistryDeps: AgentRegistryDeps = {};
export const setAgentRegistryDeps = (deps: AgentRegistryDeps): void => {
  agentRegistryDeps = deps;
};

/**
 * 适配器 —— 项目的 IncrementalScanner 返回 `FileEntry` 形态的对象,
 * 它在结构上满足 core 中的 `WorkspaceEntryLike`。
 */
const wrapScanner = (): IncrementalScannerLike => {
  const scanner = getIncrementalScanner();
  const adaptEntries = (entries: FileEntry[]): WorkspaceEntryLike[] =>
    entries.map((e) => ({
      name: e.name,
      path: e.path,
      isDirectory: e.isDirectory,
      size: e.size,
      extension: e.extension,
      modifiedAt: e.modifiedAt,
    }));
  return {
    async scanIncremental(
      absDir: string,
      forceRescan: boolean,
    ): Promise<IncrementalScanResult> {
      const r = await scanner.scanIncremental(absDir, forceRescan);
      // 项目的 scanner 以原始路径形式报告被删除的条目;下游只消费
      // .length,因此每个路径用一个空记录占位即可保留计数。
      const deletedAsEntries: WorkspaceEntryLike[] = r.deleted.map(
        (p): WorkspaceEntryLike => ({
          name: p,
          path: p,
          isDirectory: false,
          size: 0,
          extension: "",
          modifiedAt: "",
        }),
      );
      return {
        totalFiles: r.totalFiles,
        added: adaptEntries(r.added),
        modified: adaptEntries(r.modified),
        deleted: deletedAsEntries,
        unchanged: adaptEntries(r.unchanged),
        scanTime: r.scanTime,
      };
    },
    getCacheStats() {
      return scanner.getCacheStats();
    },
    async clearCache(absDir?: string) {
      await scanner.clearCache(absDir);
    },
  };
};

/**
 * 与 IPC 耦合的工具,将下一轮助手回合推迟到用户回复之后。沿用
 * `createPlan` 的挂起模式:发出一个 UI 事件,然后等待一个
 * `pendingClarifications` resolver —— 当用户选择某个选项(或输入一条
 * 被路由回此 taskId 的回复)时,由 `ai:answerClarification` IPC handler
 * 调用它。
 *
 * 这里返回一个 Promise 才是真正暂停 agent 循环的关键 —— 之前的实现
 * 同步返回 `{ asked: true }`,导致模型在用户选择选项之前就继续生成了。
 */
const askClarificationTool = (
  sender: WebContents,
  taskId: string,
): ToolDefinition<
  { question: string; options?: string[] },
  { answer: string }
> => ({
  name: "askClarification",
  description:
    "Ask the user a clarification question (optionally with multiple-choice options). Use this when the user's intent is ambiguous. This tool BLOCKS — it does not return until the user replies, and the reply is given back to you as the `answer` field. Do NOT continue generating after calling it; wait for the result.",
  safety: "safe",
  inputSchema: z.object({
    question: z.string().describe("The clarification question to ask"),
    options: z
      .array(z.string())
      .optional()
      .describe("Optional multiple-choice options for the user"),
  }),
  execute: async ({ question, options }) => {
    // 按调用生成 UUID,这样同一任务上的并发澄清请求不会互相覆盖各自
    // 的 resolver(之前以 taskId 为键的 Map.set 会丢掉第一个 Promise)。
    const clarificationId = crypto.randomUUID();
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-clarification", {
        id: taskId,
        clarificationId,
        question,
        options: options?.filter(Boolean),
      });
    }
    return new Promise<{ answer: string }>((resolve, reject) => {
      pendingClarifications.set(clarificationId, {
        taskId,
        resolve: (answer) => {
          // 在此回调触发前,Map 条目已由 drainClarificationResolver /
          // drainClarificationsForTask 移除;这里无需再次删除。
          if (answer === null) {
            reject(new Error("User cancelled the clarification"));
          } else {
            resolve({ answer });
          }
        },
      });
    });
  },
});

/**
 * 与 IPC 耦合的工具,在聊天 UI 中发出 / 刷新一份清单式计划。
 *
 * TodoWrite 风格:由模型决定何时一个任务值得做出可见的拆解
 * (3 个以上离散动作)。每次调用都会替换该任务当前的计划 —— 随着
 * 工作推进,模型会带着更新后的状态重新发送完整步骤列表。渲染层按
 * 确定性的 `inline-<taskId>` id 匹配(每任务一份计划),并就地更新
 * 已有的 `PlanMessagePart`,因此模型自身无需追踪 plan id。
 *
 * `status: "executing"` 会隐藏 `plan-viewer.tsx` 中的审批按钮 ——
 * 这些按钮仅在 `status === "draft"` 时渲染(遗留的 `ai:generatePlan`
 * 路径)。本工具不会暂停 agent 循环。
 */
const createPlanTool = (
  sender: WebContents,
  taskId: string,
): ToolDefinition<
  {
    goal: string;
    steps: Array<{
      action: string;
      description?: string;
      status?: "pending" | "running" | "completed" | "failed" | "skipped";
    }>;
  },
  unknown
> => ({
  name: "createPlan",
  description: [
    "Publish or update a checklist plan shown inline in the chat.",
    "PLAN FIRST: call this BEFORE any other tool calls when the task has 3+",
    "discrete steps or multiple deliverables — research, comparison, selection,",
    "planning, multi-section writing all count. Do NOT run webSearch/runCommand",
    "first and then plan retroactively.",
    "Initial plan can be COARSE (e.g. 'research X / research Y / compare /",
    "recommend') — subsequent calls may add, split, or refine steps as you",
    "learn more.",
    "FIRST call (initial plan, all steps pending) pauses until the user clicks",
    "「开始」 — the tool returns once approved; on rejection the call fails and",
    "you should stop. Subsequent status-update calls do NOT pause — call again",
    "with the (possibly refined) step list and updated `status` fields as you",
    "progress (pending → running → completed).",
    "Skip this tool only for 1-2 step asks where plain narration is enough.",
  ].join(" "),
  safety: "safe",
  inputSchema: z.object({
    goal: z
      .string()
      .min(1)
      .describe("One-sentence summary of what the plan accomplishes."),
    steps: z
      .array(
        z.object({
          action: z
            .string()
            .min(1)
            .describe("Short verb-phrase label for the step."),
          description: z
            .string()
            .optional()
            .describe("Optional context — file/path/concern (one line)."),
          status: z
            .enum(["pending", "running", "completed", "failed", "skipped"])
            .optional()
            .describe("Default: pending. Update on subsequent calls."),
        }),
      )
      .min(1)
      .describe("Ordered list of steps. Re-send the full list to update."),
  }),
  execute: async ({ goal, steps }) => {
    const alreadyApproved = approvedInlinePlanTasks.has(taskId);
    const plan = {
      id: makeInlinePlanId(taskId),
      goal,
      status: alreadyApproved ? ("executing" as const) : ("draft" as const),
      steps: steps.map((s, i) => ({
        id: i + 1,
        action: s.action,
        description: s.description ?? "",
        status: s.status ?? ("pending" as const),
      })),
    };
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-plan", { id: taskId, plan });
    }

    if (alreadyApproved) {
      return { recorded: true, stepCount: steps.length };
    }

    // 首次调用:暂停,直到用户通过 ai:approvePlan / ai:rejectPlan
    // 批准或拒绝。cleanupTask / stopTaskExecution 也会以 `approved=false`
    // 解决它,因此该 Promise 永不泄漏。
    const approval = new Promise<{
      recorded: boolean;
      approved: boolean;
      stepCount: number;
    }>((resolve, reject) => {
      pendingPlanApprovals.set(taskId, (approved) => {
        pendingPlanApprovals.delete(taskId);
        if (approved) {
          approvedInlinePlanTasks.add(taskId);
          resolve({ recorded: true, approved: true, stepCount: steps.length });
        } else {
          reject(new Error("User rejected the plan"));
        }
      });
    });
    // 用同一份批准门控该任务的其它所有工具,使计划仍是草稿时不会有任何
    // 工具运行。在禁用并行工具调用的情况下(见 provider adapters),
    // createPlan 在其步骤中是单独存在的,因此对这些 provider 而言此门控
    // 无竞态,其余情况则尽力而为。
    registerPlanGate(
      taskId,
      approval.then(
        () => true,
        () => false,
      ),
    );
    return approval;
  },
});

const spawnSubagentInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        goal: z
          .string()
          .min(1)
          .describe(
            "One sentence stating exactly what this sub-agent must accomplish. It does NOT see your conversation.",
          ),
        prompt: z
          .string()
          .min(1)
          .describe(
            "Full instructions plus ALL context the sub-agent needs (file paths, constraints, what to return). Assume zero shared memory.",
          ),
        outputFormat: z
          .enum(["summary", "json", "answer", "patch"])
          .default("summary")
          .describe(
            "How the sub-agent must shape its result. Use 'json' only when you will machine-consume the artifacts.",
          ),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict this sub-agent to a SUBSET of your tools. Omit to inherit your set. Cannot exceed what you have.",
          ),
        allowedSkills: z
          .array(z.string())
          .optional()
          .describe(
            "Subset of skill ids the sub-agent may use. Omit to inherit yours. Cannot exceed yours.",
          ),
        maxTurns: z.number().int().min(1).max(20).optional(),
        maxTotalTokens: z.number().int().min(1000).optional(),
        maxWallMs: z.number().int().min(5000).optional(),
      }),
    )
    .min(1)
    .max(6)
    .describe(
      "One entry per parallel sub-agent. Provide multiple ONLY for genuinely independent sub-tasks.",
    ),
  concurrency: z.number().int().min(1).max(4).default(3),
  failFast: z
    .boolean()
    .default(false)
    .describe("If true, the first failing sub-agent cancels the rest."),
});

type SpawnSubagentInput = z.infer<typeof spawnSubagentInputSchema>;

interface SpawnSubagentDeps {
  sender: WebContents;
  /** 父任务 id —— 用于子事件路由(parentTaskId)。 */
  taskId: string;
  parentSignal: AbortSignal;
  llmConfigId?: string;
  workspacePath: string;
  /** 父 agent 的工具白名单(undefined=全部)。子工具集不可超此。 */
  parentAllowedTools?: string[];
  /** 父 agent 可委派的 skill id 全集。 */
  parentAllowedSkills?: string[];
}

/**
 * 工具集子集求交:子 agent 的可用工具不能超过父 agent。
 *  - 子未指定 → 继承父集
 *  - 父=全部(undefined)→ 用子的请求
 *  - 两者都有 → 取交集
 */
const intersectTools = (
  parent: string[] | undefined,
  requested: string[] | undefined,
): string[] | undefined => {
  if (!requested) return parent;
  if (!parent) return requested;
  return requested.filter((t) => parent.includes(t));
};

/**
 * LLM 可调用的委派工具。把模型给的任务数组翻译成 ForkPoolItem[],经
 * `runForkBatch` 有界并发执行一批隔离上下文的子 agent,把结构化报告作为
 * tool-result 返回供模型下一回合消费。
 *
 * 设计要点:
 *  - 每个子 agent 走 fork-skill-runner → 同一套沙箱 / 审批 / 工具注册,
 *    天然继承父能力;allowedTools / allowedSkills 取父子交集,父级据此限制。
 *  - 三硬上限(turn/token/wall)经 SubAgentContract.termination 下发,
 *    最终由 AgentLoop 强制。
 *  - 子事件通过 ai:subagent-* 通道(携带 parentTaskId)流回 UI,可观测。
 *  - 子 agent 路径 enableSubagent=false → 无法再委派,防递归。
 *  - runForkBatch 经动态 import 引入,规避 agent-tools↔fork-pool 循环依赖。
 */
const spawnSubagentTool = (
  deps: SpawnSubagentDeps,
): ToolDefinition<SpawnSubagentInput, unknown> => ({
  name: "spawnSubagent",
  description: [
    "Delegate one or more independent, well-scoped sub-tasks to fresh sub-agents that run in ISOLATED context (they cannot see this conversation) and return a structured report you consume next turn.",
    "",
    "PREFER THIS over running searches/reads one-by-one yourself whenever the work splits into independent parallel units. For a request like 'research/compare X, Y, Z', open one sub-agent per item in a SINGLE call instead of N sequential webSearch calls.",
    "",
    "WHEN TO USE:",
    "- Multi-topic research or comparison — one sub-agent per topic (e.g. compare 3 frameworks/libraries → 3 sub-agents).",
    "- Genuinely independent sub-tasks that can run in parallel (e.g. analyze 3 separate directories).",
    "- Large/noisy exploration you want kept OUT of your context (e.g. read 50 files and return one paragraph).",
    "- Same-shape fan-out (apply the same processing to each of N inputs).",
    "",
    "WHEN NOT TO USE:",
    "- Single-step or linear tasks — just do them yourself, it's faster and cheaper.",
    "- Tasks needing back-and-forth with the user — sub-agents cannot ask the user questions.",
    "- Tasks with ordering dependencies — sub-agents run in parallel and cannot talk to each other; sequence those yourself across turns.",
    "",
    "HARD LIMITS: each sub-agent has turn / token / wall-clock caps; sub-agents cannot spawn their own sub-agents; allowedTools / allowedSkills can only be a SUBSET of yours.",
    "RESULT: returns a `reports` array (one per task) with status / summary / artifacts. Synthesize them yourself for the user next turn.",
  ].join("\n"),
  safety: "destructive",
  inputSchema: spawnSubagentInputSchema,
  execute: async (input, ctx) => {
    const batchId = `batch-${crypto.randomUUID()}`;
    // 与 runForkBatch 内部的钳制保持一致,避免 UI 卡显示的并发数
    // 超过实际启动的 worker 数(如 2 个任务 + concurrency 4)。
    const concurrency = Math.max(
      1,
      Math.min(input.concurrency ?? 3, input.tasks.length),
    );

    // 预生成 childTaskId(必须与 runForkBatch 的显式 item.taskId 一致),
    // 先发 spawn 事件让 UI 立刻出现进度卡。
    const items = input.tasks.map((task, idx) => {
      const childTaskId = `${batchId}:${idx}`;
      const allowedTools = intersectTools(
        deps.parentAllowedTools,
        task.allowedTools,
      );
      // skill 子集:子请求 ∩ 父全集;再解析描述注入子 systemPrompt。
      const childSkillIds = task.allowedSkills
        ? task.allowedSkills.filter(
            (s) => deps.parentAllowedSkills?.includes(s) ?? false,
          )
        : (deps.parentAllowedSkills ?? []);
      const allowedSkills = childSkillIds
        .map((id) => {
          const sk = skillRegistry.getById(id);
          return sk ? { id: sk.id, description: sk.description } : undefined;
        })
        .filter(
          (s): s is { id: string; description: string } => s !== undefined,
        );

      const systemPrompt = wrapWithSecurityBoundary(
        buildSubagentSystemPrompt({
          workspacePath: deps.workspacePath,
          goal: task.goal,
          allowedTools,
          allowedSkills,
        }),
        `subagent:${childTaskId}`,
      );

      const contract: SubAgentContract = {
        goal: task.goal,
        input: { prompt: task.prompt },
        output: { format: task.outputFormat as SubAgentOutputFormat },
        termination: {
          maxTurns: task.maxTurns ?? DEFAULT_SUB_AGENT_MAX_TURNS,
          maxTotalTokens:
            task.maxTotalTokens ?? DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS,
          maxWallMs: task.maxWallMs ?? DEFAULT_SUB_AGENT_MAX_WALL_MS,
        },
      };

      return {
        childTaskId,
        goal: task.goal,
        item: {
          contract,
          systemPrompt,
          workspacePath: deps.workspacePath,
          allowedTools,
          taskId: childTaskId,
        },
      };
    });

    if (!deps.sender.isDestroyed()) {
      deps.sender.send("ai:subagent-spawn", {
        parentTaskId: deps.taskId,
        batchId,
        toolCallId: ctx.toolCallId,
        concurrency,
        children: items.map((i) => ({
          childTaskId: i.childTaskId,
          goal: i.goal,
        })),
      });
    }

    // 动态 import 规避 agent-tools → fork-pool → fork-skill-runner → agent-tools 循环。
    const { runForkBatch } = await import("./fork-pool");
    const result = await runForkBatch(
      items.map((i) => i.item),
      {
        sender: deps.sender,
        // ctx.signal 已合并父 signal + 工具级 signal。
        parentSignal: ctx.signal,
        parentTaskId: deps.taskId,
        workspacePath: deps.workspacePath,
        llmConfigId: deps.llmConfigId,
      },
      {
        concurrency,
        failFast: input.failFast === true,
        forkBatchId: batchId,
      },
    );

    return {
      success: true,
      batchId,
      // reports 与 items 同序(runForkBatch 按 idx 回填),用 index 取回
      // 派发时的 goal 文本,让父 agent 能把报告对应到它委派的任务
      //(r.agentId 是合成的 childTaskId,对父 agent 无意义)。
      reports: result.reports.map((r, i) => ({
        goal: input.tasks[i]?.goal ?? r.agentId,
        status: r.status,
        summary: r.summary,
        artifacts: r.artifacts,
        usage: r.usage,
        error: r.error,
      })),
    };
  },
});

export const buildAgentToolRegistry = ({
  sender,
  taskId,
  allowedTools,
  modelName,
  isGitWorkspace,
  enableSubagent,
  parentSignal,
  llmConfigId,
  workspacePath,
  parentAllowedSkills,
}: BuildAgentToolRegistryOptions): ToolRegistry => {
  const registry = new ToolRegistry();
  const allow = (name: string): boolean =>
    !allowedTools || allowedTools.includes(name);

  const gitProtocol = isGitWorkspace
    ? buildGitRunCommandProtocol(modelName ?? "filework-agent")
    : undefined;

  // db 未初始化(如部分单测)时回落默认沙箱配置,不阻断工具装配。
  let sandboxModeSetting: string | null = null;
  try {
    sandboxModeSetting = getSetting("sandboxMode");
  } catch {
    sandboxModeSetting = null;
  }

  for (const def of buildFileTools({
    incrementalScanner: wrapScanner(),
    searchFiles: nativeSearchFiles,
    gitProtocol,
    sandbox: resolveSandboxConfig(sandboxModeSetting),
  })) {
    if (allow(def.name)) registry.register(def);
  }

  if (allow("askClarification")) {
    registry.register(askClarificationTool(sender, taskId));
  }

  if (allow("createPlan")) {
    registry.register(createPlanTool(sender, taskId));
  }

  // 工作目录记忆：允许 Agent 把可复用事实写入 AGENTS.md，后续任务直接读取。
  if (allow("updateMemory")) {
    registry.register(updateMemoryTool);
  }

  // 一次性清空记忆(user / workspace / all)—— 对应「清理 memory」等指令。
  if (allow("clearMemory")) {
    registry.register(clearMemoryTool);
  }

  // Web 工具(Layer 0 搜索 + Layer 1/2'/4 抽取)。仅当注入了 fetch 实现
  // 时才注册 —— 生产环境接入 `proxyAwareFetch`;测试通常省略,故也省略
  // 这些工具。search/scrape 还额外需要各自的 resolver,因为它们需要已
  // 存储的 API key;render-fetch 除 Electron 外无需任何其它依赖。
  if (agentRegistryDeps.fetchFn) {
    {
      const def = buildWebFetchTool({ fetchImpl: agentRegistryDeps.fetchFn });
      if (allow(def.name)) registry.register(def);
    }
    {
      const def = buildWebFetchRenderedTool();
      if (allow(def.name)) registry.register(def);
    }
    // 交互式浏览 —— 支持点击/输入的有状态 Chromium 会话。与
    // `webFetchRendered` 共用同一 Electron 运行时,无额外依赖。与 web
    // 工具栈一并注册,这样任何放行了 `webFetchRendered` 的 skill 都可通过
    // 在其 `allowed-tools` 中加入 `browserOpen` 等来选用交互式流程。
    for (const def of buildBrowserInteractiveTools()) {
      if (allow(def.name)) registry.register(def);
    }
    {
      const def = buildYoutubeTranscriptTool({
        fetchImpl: agentRegistryDeps.fetchFn,
      });
      if (allow(def.name)) registry.register(def);
    }
    if (agentRegistryDeps.resolveTavilyToken) {
      const def = buildWebSearchTool({
        fetchImpl: agentRegistryDeps.fetchFn,
        resolveTavilyToken: agentRegistryDeps.resolveTavilyToken,
      });
      if (allow(def.name)) registry.register(def);
    }
    if (agentRegistryDeps.resolveFirecrawlToken) {
      const def = buildWebScrapeTool({
        fetchImpl: agentRegistryDeps.fetchFn,
        resolveFirecrawlToken: agentRegistryDeps.resolveFirecrawlToken,
      });
      if (allow(def.name)) registry.register(def);
    }
  }

  // MCP 工具 —— 为每个当前已连接且已启用的 server 所暴露的每个工具
  // 各生成一个 ToolDefinition。安全级别按 server 通过 `trusted` 标志决定
  // (见 `mcp/tool-bridge.ts`);名称以 `mcp__<serverSlug>__` 为前缀,
  // 这样 `allowed-tools` 白名单机制和 agent 循环既有的工具结果 UI 就能
  // 像处理内置工具一样路由它们。
  for (const def of mcpManager.getActiveToolDefs()) {
    if (allow(def.name)) registry.register(def);
  }

  // spawnSubagent —— 仅主 agent 路径注册(enableSubagent)。子 agent 路径
  // 缺省 false,因此子 agent 拿不到此工具,无法递归委派。
  if (
    enableSubagent &&
    parentSignal &&
    workspacePath &&
    allow("spawnSubagent")
  ) {
    registry.register(
      spawnSubagentTool({
        sender,
        taskId,
        parentSignal,
        llmConfigId,
        workspacePath,
        parentAllowedTools: allowedTools,
        parentAllowedSkills,
      }),
    );
  }

  return registry;
};
