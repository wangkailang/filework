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
import { buildGitTools } from "../core/agent/tools/git-tools";
import { buildGithubTools } from "../core/agent/tools/github-tools";
import { buildGitlabTools } from "../core/agent/tools/gitlab-tools";
import type { Workspace } from "../core/workspace/types";
import {
  type FileEntry,
  getIncrementalScanner,
} from "../utils/incremental-scanner";
import { ciWatcher } from "./ci-watcher";

interface BuildAgentToolRegistryOptions {
  sender: WebContents;
  taskId: string;
  workspace: Workspace;
  /** Restrict to this allow-list when set (skill `allowed-tools` frontmatter). */
  allowedTools?: string[];
}

/** Workspace kinds that own a `WorkspaceSCM` with commit/push/openPullRequest. */
const SCM_WRITE_KINDS = new Set(["github", "gitlab"]);

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
  workspace,
  allowedTools,
}: BuildAgentToolRegistryOptions): ToolRegistry => {
  const registry = new ToolRegistry();
  const allow = (name: string): boolean =>
    !allowedTools || allowedTools.includes(name);

  for (const def of buildFileTools({ incrementalScanner: wrapScanner() })) {
    if (allow(def.name)) registry.register(def);
  }

  // M12: after a rerun is approved + executed, auto-subscribe the run to
  // the CI watcher so the user sees an inline notification when it
  // finishes — without the agent having to poll. Wrapped at registration
  // time because per-call sender/taskId context lives in this closure.
  //
  // M13: dispatch is also wrapped — GitHub `/dispatches` returns 204+empty
  // so we don't have a runId, but `subscribeAfterDispatch` resolves it via
  // a short retry loop on listCIRuns and then falls through to subscribe.
  //
  // M14: gitlabCreatePipeline joins the "direct" set — GitLab `POST
  // /pipeline` returns the pipeline JSON synchronously (with id), so the
  // tool returns {runId, queued} the same shape as rerun and the wrapper
  // subscribes immediately without M13's resolve-retry dance.
  const CI_WATCH_DIRECT_TOOLS = new Set([
    "githubRerunWorkflowRun",
    "githubRerunFailedJobs",
    "gitlabRetryPipeline",
    "gitlabCreatePipeline",
  ]);
  const CI_WATCH_DISPATCH_TOOLS = new Set(["githubDispatchWorkflow"]);
  const maybeWrapWithWatcher = (def: ToolDefinition): ToolDefinition => {
    if (CI_WATCH_DIRECT_TOOLS.has(def.name)) {
      const original = def.execute;
      return {
        ...def,
        execute: async (args, ctx) => {
          const result = await original(args, ctx);
          const r = result as { runId?: string; queued?: boolean } | undefined;
          if (r?.queued && r.runId) {
            ciWatcher.subscribe({
              workspace: ctx.workspace,
              runId: r.runId,
              sender,
              taskId,
              signal: ctx.signal,
            });
          }
          return result;
        },
      };
    }
    if (CI_WATCH_DISPATCH_TOOLS.has(def.name)) {
      const original = def.execute;
      return {
        ...def,
        execute: async (args, ctx) => {
          const result = await original(args, ctx);
          const r = result as
            | { workflowFile?: string; ref?: string; queued?: boolean }
            | undefined;
          if (r?.queued && r.ref && r.workflowFile) {
            // Fire and forget — the resolve loop runs up to ~6s; blocking
            // here would stall the tool's return.
            void ciWatcher.subscribeAfterDispatch({
              workspace: ctx.workspace,
              ref: r.ref,
              workflowFile: r.workflowFile,
              sender,
              taskId,
              signal: ctx.signal,
            });
          }
          return result;
        },
      };
    }
    return def;
  };

  // Git write tools register only for SCM-write-capable workspaces
  // (currently github + gitlab). Local workspaces deliberately don't
  // get them — local git workflows have separate UX considerations
  // (which remote, which auth) handled outside this PR. Native query /
  // comment tools register per provider in the same conditional and
  // rely on the workspace's stored PAT for auth.
  if (SCM_WRITE_KINDS.has(workspace.kind)) {
    for (const def of buildGitTools()) {
      if (allow(def.name)) registry.register(def);
    }
    if (workspace.kind === "github") {
      for (const def of buildGithubTools()) {
        if (allow(def.name)) registry.register(maybeWrapWithWatcher(def));
      }
    }
    if (workspace.kind === "gitlab") {
      for (const def of buildGitlabTools()) {
        if (allow(def.name)) registry.register(maybeWrapWithWatcher(def));
      }
    }
  }

  if (allow("askClarification")) {
    registry.register(askClarificationTool(sender, taskId));
  }

  return registry;
};
