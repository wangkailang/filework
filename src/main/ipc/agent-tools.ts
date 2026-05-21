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
import {
  type FileEntry,
  getIncrementalScanner,
} from "../utils/incremental-scanner";
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

/** IPC-coupled tool that defers the next assistant turn until user replies. */
const askClarificationTool = (
  sender: WebContents,
  taskId: string,
): ToolDefinition<{ question: string; options?: string[] }, unknown> => ({
  name: "askClarification",
  description:
    "Ask the user a clarification question (optionally with multiple-choice options). Use this when the user's intent is ambiguous. After calling this tool, stop and wait for the user's reply.",
  safety: "safe",
  inputSchema: z.object({
    question: z.string().describe("The clarification question to ask"),
    options: z
      .array(z.string())
      .optional()
      .describe("Optional multiple-choice options for the user"),
  }),
  execute: async ({ question, options }) => {
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-clarification", {
        id: taskId,
        question,
        options: options?.filter(Boolean),
      });
    }
    return { asked: true };
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

  return registry;
};
