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
  DEFAULT_SUB_AGENT_RESULT_SCHEMA,
  type SubAgentContract,
  type SubAgentOutputFormat,
  type SubAgentReport,
} from "../core/agent/sub-agent-contract";
import { type ToolDefinition, ToolRegistry } from "../core/agent/tool-registry";
import {
  buildFileTools,
  type IncrementalScannerLike,
  type IncrementalScanResult,
  type WorkspaceEntryLike,
} from "../core/agent/tools";
import { buildAutomationUpdateTool } from "../core/agent/tools/automation";
import { buildBrowserInteractiveTools } from "../core/agent/tools/browser-interactive";
import { clearMemoryTool, updateMemoryTool } from "../core/agent/tools/memory";
import { buildWebFetchTool } from "../core/agent/tools/web-fetch";
import { buildWebFetchRenderedTool } from "../core/agent/tools/web-fetch-rendered";
import { buildWebScrapeTool } from "../core/agent/tools/web-scrape";
import { buildWebSearchTool } from "../core/agent/tools/web-search";
import { buildYoutubeTranscriptTool } from "../core/agent/tools/youtube-transcript";
import { resolveSandboxConfig } from "../core/sandbox";
import type { SandboxMode } from "../core/sandbox/types";
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
  SUBAGENT_PROFILE_VALUES,
  type SubagentProfile,
} from "./system-prompt";

interface BuildAgentToolRegistryOptions {
  sender: WebContents;
  taskId: string;
  /** 设置后限定为此 allow-list(skill 的 `allowed-tools` frontmatter)。 */
  allowedTools?: string[];
  /**
   * 仅当用户明确要求记住 / 清理记忆时开启 memory 工具。默认关闭,
   * 避免普通咨询任务把一次性结果写入持久记忆。
   */
  enableMemoryTools?: boolean;
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
  /** 当前聊天会话 id。thread automation 默认绑定到这个会话。 */
  currentThreadId?: string;
  /**
   * spawnSubagent 用:父 agent 当前可委派的 skill id 全集。子 agent 的
   * allowedSkills 只能是它的子集(主 agent 限制子 agent 能力的硬边界)。
   * 缺省 → 子 agent 不获注入任何 skill 描述。
   */
  parentAllowedSkills?: string[];
  /** 当前 chat turn 指定的沙箱模式;缺省时读取全局设置。 */
  sandboxMode?: SandboxMode;
  /** 当前 chat turn 是否自动批准首个内联执行计划。 */
  autoApprovePlans?: boolean;
}

export const shouldEnableMemoryToolsForPrompt = (prompt: string): boolean => {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  if (
    /(不要|别|无需|不需要|不应该).{0,12}(记住|保存|写入|更新|记忆|memory)/i.test(
      normalized,
    )
  ) {
    return false;
  }

  const explicitChineseMemoryIntent =
    /(请|帮我|替我)?\s*(记住|记一下|记下来|保存|存下|存一下|写入|加入|放进|更新到|记录到).{0,24}(记忆|memory|workspace memory|工作区记忆|用户记忆)/i.test(
      normalized,
    ) ||
    /(清空|清理|重置|删除|忘记|移除).{0,16}(记忆|memory|workspace memory|工作区记忆|用户记忆)/i.test(
      normalized,
    ) ||
    /^(请|帮我|替我)?\s*(记住|记一下|记下来)/i.test(normalized);

  const explicitEnglishMemoryIntent =
    /^(please\s+)?remember\s+(this|that|my|our)\b/i.test(normalized) ||
    /\b(save|store|add|write|record)\b.{0,24}\b(to|in|into)\b.{0,12}\b(memory|workspace memory|user memory)\b/i.test(
      normalized,
    ) ||
    /^(please\s+)?update\s+(workspace\s+|user\s+)?memory\b/i.test(normalized) ||
    /\b(clear|reset|delete|forget|remove)\b.{0,16}\b(memory|workspace memory|user memory)\b/i.test(
      normalized,
    );

  return explicitChineseMemoryIntent || explicitEnglishMemoryIntent;
};

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
 * 路径)。首个计划是否暂停取决于当前 chat 权限:请求审批会暂停,
 * 替我审批/完全访问权限会自动批准并继续。
 */
const createPlanTool = (
  sender: WebContents,
  taskId: string,
  {
    autoApprovePlans = false,
  }: {
    autoApprovePlans?: boolean;
  } = {},
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
    autoApprovePlans
      ? "FIRST call (initial plan, all steps pending) is auto-approved by the current chat permissions; continue executing it immediately."
      : "FIRST call (initial plan, all steps pending) pauses until the user clicks 「开始」 — the tool returns once approved; on rejection the call fails and you should stop.",
    "After approval, continue executing the approved plan immediately; do not",
    "treat publishing the plan as the final answer.",
    "Subsequent status-update calls do NOT pause — call again",
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
    const hasOpenWork = steps.some((step) => {
      const status = step.status ?? "pending";
      return (
        status !== "completed" && status !== "failed" && status !== "skipped"
      );
    });
    const continuation = {
      continueExecution: hasOpenWork,
      nextInstruction: hasOpenWork
        ? "Continue executing the approved plan now. Work through the next pending or running step before giving a final answer."
        : "All plan steps are marked terminal. Provide the final answer now.",
    };
    const alreadyApproved = approvedInlinePlanTasks.has(taskId);
    const isApproved = alreadyApproved || autoApprovePlans;
    if (isApproved) {
      approvedInlinePlanTasks.add(taskId);
    }
    const plan = {
      id: makeInlinePlanId(taskId),
      goal,
      status: isApproved ? ("executing" as const) : ("draft" as const),
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

    if (isApproved) {
      return {
        recorded: true,
        approved: true,
        autoApproved: autoApprovePlans && !alreadyApproved,
        stepCount: steps.length,
        ...continuation,
      };
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
          resolve({
            recorded: true,
            approved: true,
            stepCount: steps.length,
            ...continuation,
          });
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
        profile: z
          .enum(SUBAGENT_PROFILE_VALUES)
          .optional()
          .describe(
            "Optional specialist profile: researcher, code_reviewer, test_analyst, or doc_summarizer.",
          ),
        outputFormat: z
          .enum(["summary", "json", "answer", "patch"])
          .default("json")
          .describe(
            "How the sub-agent must shape its result. Default json returns a validated RESULT_JSON artifact the parent can safely consume.",
          ),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict this sub-agent to a SUBSET of your read-only tools. Use canonical names like readFile/runCommand; provider prefixes such as functions.readFile are tolerated. Direct-write, memory, automation, and delegation tools are filtered out; shell tools are limited to read-only inspection.",
          ),
        allowedSkills: z
          .array(z.string())
          .optional()
          .describe(
            "Subset of skill ids the sub-agent may use. Omit for no skills. Cannot exceed yours.",
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

export interface ShapedSubagentToolResult {
  success: true;
  batchId: string;
  summary: {
    total: number;
    usable: number;
    complete: number;
    partial: number;
    noResult: number;
    failed: number;
  };
  reports: Array<{
    goal: string;
    status: SubAgentReport["status"];
    resultQuality: SubAgentReport["resultQuality"];
    usable: boolean;
    summary: string;
    artifacts?: Record<string, unknown>;
    usage: SubAgentReport["usage"];
    error?: string;
    unusableReason?: string;
  }>;
}

const isUsableSubagentReport = (report: SubAgentReport): boolean =>
  report.resultQuality === "complete" ||
  report.resultQuality === "usable_partial";

const unusableSubagentReason = (report: SubAgentReport): string | undefined => {
  if (isUsableSubagentReport(report)) return undefined;
  if (report.status === "failed") return report.error ?? "Sub-agent failed.";
  if (report.status === "cancelled")
    return report.error ?? "Sub-agent was cancelled.";
  if (report.status === "timeout" || report.status === "token_limit") {
    return "Sub-agent stopped before producing validated findings.";
  }
  return "Sub-agent produced no validated findings.";
};

export const shapeSubagentToolResult = ({
  batchId,
  goals,
  reports,
}: {
  batchId: string;
  goals: string[];
  reports: SubAgentReport[];
}): ShapedSubagentToolResult => {
  const shapedReports = reports.map((report, index) => {
    const usable = isUsableSubagentReport(report);
    return {
      goal: goals[index] ?? report.agentId,
      status: report.status,
      resultQuality: report.resultQuality,
      usable,
      summary: report.summary,
      artifacts: report.artifacts,
      usage: report.usage,
      error: report.error,
      unusableReason: usable ? undefined : unusableSubagentReason(report),
    };
  });
  const complete = shapedReports.filter(
    (report) => report.resultQuality === "complete",
  ).length;
  const partial = shapedReports.filter(
    (report) => report.resultQuality === "usable_partial",
  ).length;
  const noResult = shapedReports.filter(
    (report) => report.resultQuality === "no_result",
  ).length;
  const failed = shapedReports.filter(
    (report) => report.status === "failed",
  ).length;
  return {
    success: true,
    batchId,
    summary: {
      total: shapedReports.length,
      usable: complete + partial,
      complete,
      partial,
      noResult,
      failed,
    },
    reports: shapedReports,
  };
};

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

const SUBAGENT_DEFAULT_READ_ONLY_TOOLS = [
  "listDirectory",
  "readFile",
  "directoryStats",
  "searchFiles",
  "getCacheStats",
  "runCommand",
  "runProcess",
  "webFetch",
  "webFetchRendered",
  "webSearch",
  "webScrape",
  "youtubeTranscript",
  "browserOpen",
  "browserSnapshot",
  "browserClose",
] as const;

const SUBAGENT_READ_ONLY_TOOL_SET = new Set<string>(
  SUBAGENT_DEFAULT_READ_ONLY_TOOLS,
);

const SUBAGENT_RESEARCHER_DEFAULTS = {
  maxTurns: 16,
  maxTotalTokens: 180_000,
  maxWallMs: 300_000,
} as const;

const SUBAGENT_TOOL_NAME_PREFIXES = [
  "functions.",
  "function.",
  "tools.",
  "tool.",
] as const;

const normalizeSubagentToolName = (toolName: string): string => {
  const trimmed = toolName.trim();
  const prefix = SUBAGENT_TOOL_NAME_PREFIXES.find((candidate) =>
    trimmed.startsWith(candidate),
  );
  return prefix ? trimmed.slice(prefix.length) : trimmed;
};

const normalizeSubagentToolList = (
  tools: string[] | undefined,
): string[] | undefined =>
  tools
    ?.map((toolName) => normalizeSubagentToolName(toolName))
    .filter((toolName) => toolName.length > 0);

const intersectTools = (
  parent: string[] | undefined,
  requested: string[] | undefined,
): string[] | undefined => {
  const parentList = parent && parent.length > 0 ? parent : undefined;
  const requestedList =
    requested && requested.length > 0 ? requested : undefined;
  if (!requestedList) return parentList;
  if (!parentList) return requestedList;
  return requestedList.filter((t) => parentList.includes(t));
};

/**
 * 子 agent 默认只能获得读/查/抓取类工具。即便父 agent 或模型显式请求
 * writeFile/deleteFile 等工具,这里也会过滤掉,使写入保持在 lead agent
 * 的单写入者路径;需要改动时让子 agent 返回 patch artifact。shell
 * 工具只用于只读检查,由 fork-skill-runner 的子 agent guard 二次拦截。
 */
export const resolveSubagentAllowedTools = (
  parentAllowedTools: string[] | undefined,
  requestedTools: string[] | undefined,
): string[] => {
  const normalizedParentTools = normalizeSubagentToolList(parentAllowedTools);
  const normalizedRequestedTools = normalizeSubagentToolList(requestedTools);
  const requestedList =
    normalizedRequestedTools && normalizedRequestedTools.length > 0
      ? normalizedRequestedTools
      : undefined;
  const parentReadOnlyTools = normalizedParentTools?.filter((toolName) =>
    SUBAGENT_READ_ONLY_TOOL_SET.has(toolName),
  );
  const parentRestriction =
    parentReadOnlyTools && parentReadOnlyTools.length > 0
      ? parentReadOnlyTools
      : undefined;

  const candidates =
    requestedList !== undefined
      ? (intersectTools(parentRestriction, requestedList) ?? requestedList)
      : (parentRestriction ?? [...SUBAGENT_DEFAULT_READ_ONLY_TOOLS]);
  const readOnlyTools = candidates.filter((toolName) =>
    SUBAGENT_READ_ONLY_TOOL_SET.has(toolName),
  );
  if (readOnlyTools.length > 0) return readOnlyTools;

  // A model may pass `allowedTools: []` as an empty optional field, or a
  // coordinator skill may expose only `spawnSubagent`. In both cases the
  // useful sub-agent contract is still the built-in read-only grant.
  if (requestedList === undefined) return [...SUBAGENT_DEFAULT_READ_ONLY_TOOLS];

  return readOnlyTools;
};

export const resolveSubagentAllowedSkillIds = (
  parentAllowedSkills: string[] | undefined,
  requestedSkills: string[] | undefined,
): string[] => {
  if (!requestedSkills || requestedSkills.length === 0) return [];
  if (!parentAllowedSkills || parentAllowedSkills.length === 0) return [];
  const parentSkillSet = new Set(parentAllowedSkills);
  return requestedSkills.filter((skillId) => parentSkillSet.has(skillId));
};

export const resolveSubagentTermination = (
  profile: SubagentProfile | undefined,
  overrides: {
    maxTurns?: number;
    maxTotalTokens?: number;
    maxWallMs?: number;
  },
): Required<
  Pick<
    SubAgentContract["termination"],
    "maxTurns" | "maxTotalTokens" | "maxWallMs"
  >
> => {
  const defaults =
    profile === "researcher"
      ? SUBAGENT_RESEARCHER_DEFAULTS
      : {
          maxTurns: DEFAULT_SUB_AGENT_MAX_TURNS,
          maxTotalTokens: DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS,
          maxWallMs: DEFAULT_SUB_AGENT_MAX_WALL_MS,
        };
  return {
    maxTurns: overrides.maxTurns ?? defaults.maxTurns,
    maxTotalTokens: overrides.maxTotalTokens ?? defaults.maxTotalTokens,
    maxWallMs: overrides.maxWallMs ?? defaults.maxWallMs,
  };
};

/**
 * LLM 可调用的委派工具。把模型给的任务数组翻译成 ForkPoolItem[],经
 * `runForkBatch` 有界并发执行一批隔离上下文的子 agent,把结构化报告作为
 * tool-result 返回供模型下一回合消费。
 *
 * 设计要点:
 *  - 每个子 agent 走 fork-skill-runner → 同一套沙箱 / 审批 / 工具注册。
 *    工具授权按只读子工具策略解析,父级只读白名单可进一步收紧。
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
    "HARD LIMITS: each sub-agent has turn / token / wall-clock caps; sub-agents cannot spawn their own sub-agents; child tools are capped to read-only inspection and cannot include write, memory, automation, or delegation tools.",
    "RESULT: returns summary counts and a `reports` array. Consume only reports where `usable=true`; `resultQuality=no_result` is diagnostic trace, not evidence.",
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
      const allowedTools = resolveSubagentAllowedTools(
        deps.parentAllowedTools,
        task.allowedTools,
      );
      // skill 子集:只有模型显式请求时才注入,避免把父级所有 skill
      // 描述塞进每个 child 的初始上下文。
      const childSkillIds = resolveSubagentAllowedSkillIds(
        deps.parentAllowedSkills,
        task.allowedSkills,
      );
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
          profile: task.profile,
          allowedTools,
          allowedSkills,
        }),
        `subagent:${childTaskId}`,
      );

      const contract: SubAgentContract = {
        goal: task.goal,
        input: { prompt: task.prompt },
        output: {
          format: task.outputFormat as SubAgentOutputFormat,
          schema:
            task.outputFormat === "json"
              ? DEFAULT_SUB_AGENT_RESULT_SCHEMA
              : undefined,
        },
        termination: resolveSubagentTermination(task.profile, {
          maxTurns: task.maxTurns,
          maxTotalTokens: task.maxTotalTokens,
          maxWallMs: task.maxWallMs,
        }),
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

    // reports 与 items 同序(runForkBatch 按 idx 回填),用 index 取回
    // 派发时的 goal 文本,让父 agent 能把报告对应到它委派的任务
    //(r.agentId 是合成的 childTaskId,对父 agent 无意义)。
    return shapeSubagentToolResult({
      batchId,
      goals: input.tasks.map((task) => task.goal),
      reports: result.reports,
    });
  },
});

export const buildAgentToolRegistry = ({
  sender,
  taskId,
  allowedTools,
  enableMemoryTools,
  modelName,
  isGitWorkspace,
  enableSubagent,
  parentSignal,
  llmConfigId,
  workspacePath,
  currentThreadId,
  parentAllowedSkills,
  sandboxMode,
  autoApprovePlans,
}: BuildAgentToolRegistryOptions): ToolRegistry => {
  const registry = new ToolRegistry();
  const allow = (name: string): boolean =>
    !allowedTools || allowedTools.includes(name);
  const isExplicitlyAllowed = (name: string): boolean =>
    allowedTools?.includes(name) ?? false;
  const canUseMemoryTools =
    enableMemoryTools === true ||
    isExplicitlyAllowed("updateMemory") ||
    isExplicitlyAllowed("clearMemory");

  const gitProtocol = isGitWorkspace
    ? buildGitRunCommandProtocol(modelName ?? "filework-agent")
    : undefined;

  // db 未初始化(如部分单测)时回落默认沙箱配置,不阻断工具装配。
  let sandboxModeSetting: string | null = sandboxMode ?? null;
  if (!sandboxModeSetting) {
    try {
      sandboxModeSetting = getSetting("sandboxMode");
    } catch {
      sandboxModeSetting = null;
    }
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
    registry.register(createPlanTool(sender, taskId, { autoApprovePlans }));
  }

  // 工作区记忆：只在显式记忆意图或 tool 白名单中注册,避免普通任务落持久记忆。
  if (canUseMemoryTools && allow("updateMemory")) {
    registry.register(updateMemoryTool);
  }

  // 一次性清空记忆(user / workspace / all)—— 对应「清理 memory」等指令。
  if (canUseMemoryTools && allow("clearMemory")) {
    registry.register(clearMemoryTool);
  }

  if (allow("automation_update")) {
    registry.register(
      buildAutomationUpdateTool({
        currentThreadId,
        currentWorkspacePath: workspacePath,
      }),
    );
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
