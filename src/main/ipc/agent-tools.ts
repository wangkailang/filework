/**
 * Build a per-task `ToolRegistry` for the AgentLoop path.
 *
 * Wraps:
 *  - `core/agent/tools/buildFileTools` — the 8 core file tools, executed
 *    against the supplied `Workspace` (sandboxed via realpath checks)
 *  - `askClarification` — IPC-coupled tool that pauses the loop to ask
 *    the user a multi-choice question via `ai:stream-clarification`
 *
 * When `allowedTools` is provided (skill frontmatter `allowed-tools`),
 * only tools with matching names are registered.
 *
 * (As of M2 PR 4, this is the only tool-set builder in the codebase.
 * The legacy `buildTools` / `buildSkillSpecificTools` in
 * `ai-tool-permissions.ts` were deleted; fork-mode now also goes
 * through this registry via `fork-skill-runner.ts`.)
 */

import crypto from "node:crypto";
import type { WebContents } from "electron";
import { z } from "zod/v4";
import { type ToolDefinition, ToolRegistry } from "../core/agent/tool-registry";
import {
  buildFileTools,
  type IncrementalScannerLike,
  type IncrementalScanResult,
  type WorkspaceEntryLike,
} from "../core/agent/tools";
import { buildBrowserInteractiveTools } from "../core/agent/tools/browser-interactive";
import { buildWebFetchTool } from "../core/agent/tools/web-fetch";
import { buildWebFetchRenderedTool } from "../core/agent/tools/web-fetch-rendered";
import { buildWebScrapeTool } from "../core/agent/tools/web-scrape";
import { buildWebSearchTool } from "../core/agent/tools/web-search";
import { buildYoutubeTranscriptTool } from "../core/agent/tools/youtube-transcript";
import { mcpManager } from "../mcp/manager";
import {
  type FileEntry,
  getIncrementalScanner,
} from "../utils/incremental-scanner";
import {
  approvedInlinePlanTasks,
  makeInlinePlanId,
  pendingClarifications,
  pendingPlanApprovals,
} from "./ai-task-control";
import { buildGitRunCommandProtocol } from "./system-prompt";

interface BuildAgentToolRegistryOptions {
  sender: WebContents;
  taskId: string;
  /** Restrict to this allow-list when set (skill `allowed-tools` frontmatter). */
  allowedTools?: string[];
  /**
   * Resolved LLM identifier — flows into the L2 git protocol's
   * `Co-Authored-By` trailer (embedded in `runCommand`'s description
   * when `isGitWorkspace` is true). Falls back to "filework-agent".
   */
  modelName?: string;
  /**
   * True when the active workspace is git-backed. Gates whether the
   * L2 git protocol (HEREDOC commit, `gh` / `glab` PR templates) is
   * embedded in the `runCommand` tool description. See
   * `system-prompt.buildGitRunCommandProtocol` for the rationale.
   */
  isGitWorkspace?: boolean;
}

/**
 * Module-level deps injected once at app startup (mirrors
 * `setWorkspaceFactoryDeps` in `ai-handlers.ts`). The agent registry
 * builder is called per-task from multiple call sites; keeping the
 * proxy-aware fetch here avoids threading it through every option bag.
 */
interface AgentRegistryDeps {
  fetchFn?: typeof fetch;
  /** Returns the most recent Tavily API key or null. Gates `webSearch`. */
  resolveTavilyToken?: () => Promise<string | null>;
  /** Returns the most recent Firecrawl API key or null. Gates `webScrape`. */
  resolveFirecrawlToken?: () => Promise<string | null>;
}
let agentRegistryDeps: AgentRegistryDeps = {};
export const setAgentRegistryDeps = (deps: AgentRegistryDeps): void => {
  agentRegistryDeps = deps;
};

/**
 * Adapter — the project's IncrementalScanner returns `FileEntry`-shaped
 * objects which structurally satisfy `WorkspaceEntryLike` from core.
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
      // The project's scanner reports deleted entries as raw paths; we only
      // consume .length downstream, so an empty-record placeholder per path
      // is enough to preserve the count.
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
 * IPC-coupled tool that defers the next assistant turn until the user
 * replies. Mirrors the `createPlan` suspension pattern: emit a UI event,
 * then await a `pendingClarifications` resolver that the
 * `ai:answerClarification` IPC handler invokes when the user picks an
 * option (or types a reply routed back to this taskId).
 *
 * Returning a Promise here is what actually pauses the agent loop — the
 * previous implementation returned `{ asked: true }` synchronously and
 * the model kept generating before the user could pick an option.
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
    // Per-call UUID so concurrent clarifications on the same task don't
    // overwrite each other's resolver (the previous taskId-keyed Map.set
    // dropped the first Promise on the floor).
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
          // Map entry is already removed by drainClarificationResolver /
          // drainClarificationsForTask before this callback fires; no
          // need to delete again here.
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
 * IPC-coupled tool that emits / refreshes a checklist plan in the chat UI.
 *
 * TodoWrite-style: model decides when a task warrants a visible breakdown
 * (3+ discrete actions). Each call replaces the current plan for the task
 * — the model re-sends the full step list with updated statuses as work
 * progresses. Renderer matches on the deterministic `inline-<taskId>` id
 * (one plan per task) and updates the existing `PlanMessagePart` in place,
 * so the model does not need to track plan ids itself.
 *
 * `status: "executing"` suppresses the approval buttons in `plan-viewer.tsx`
 * — those only render when `status === "draft"` (the legacy `ai:generatePlan`
 * pathway). Does NOT pause the agent loop.
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

    // First call: pause until user approves or rejects via ai:approvePlan
    // / ai:rejectPlan. cleanupTask / stopTaskExecution also resolve this
    // with `approved=false` so the Promise never leaks.
    return new Promise<{
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
  },
});

export const buildAgentToolRegistry = ({
  sender,
  taskId,
  allowedTools,
  modelName,
  isGitWorkspace,
}: BuildAgentToolRegistryOptions): ToolRegistry => {
  const registry = new ToolRegistry();
  const allow = (name: string): boolean =>
    !allowedTools || allowedTools.includes(name);

  const gitProtocol = isGitWorkspace
    ? buildGitRunCommandProtocol(modelName ?? "filework-agent")
    : undefined;

  for (const def of buildFileTools({
    incrementalScanner: wrapScanner(),
    gitProtocol,
  })) {
    if (allow(def.name)) registry.register(def);
  }

  if (allow("askClarification")) {
    registry.register(askClarificationTool(sender, taskId));
  }

  if (allow("createPlan")) {
    registry.register(createPlanTool(sender, taskId));
  }

  // Web tools (Layer 0 search + Layer 1/2'/4 extraction). Registered
  // only when a fetch implementation is injected — production wires
  // `proxyAwareFetch`; tests typically omit and so omit the tools.
  // Search/scrape additionally require their resolvers since they need
  // a stored API key; render-fetch needs nothing besides Electron.
  if (agentRegistryDeps.fetchFn) {
    {
      const def = buildWebFetchTool({ fetchImpl: agentRegistryDeps.fetchFn });
      if (allow(def.name)) registry.register(def);
    }
    {
      const def = buildWebFetchRenderedTool();
      if (allow(def.name)) registry.register(def);
    }
    // Interactive browsing — stateful Chromium sessions with click/type
    // support. Same Electron runtime as `webFetchRendered`, no extra
    // deps. Registered alongside the web stack so any skill that allows
    // `webFetchRendered` can opt into interactive flows by including
    // `browserOpen` etc. in its `allowed-tools`.
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

  // MCP tools — one ToolDefinition per tool exposed by every currently-
  // connected, enabled server. Safety is decided per-server via the
  // `trusted` flag (see `mcp/tool-bridge.ts`); names are prefixed with
  // `mcp__<serverSlug>__` so the `allowed-tools` allow-list mechanism
  // and the agent loop's existing tool-result UI can route them like
  // any built-in tool.
  for (const def of mcpManager.getActiveToolDefs()) {
    if (allow(def.name)) registry.register(def);
  }

  return registry;
};
