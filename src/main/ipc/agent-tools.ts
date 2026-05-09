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
 * The legacy `buildTools` in `ai-tool-permissions.ts` continues to serve
 * the fork-mode skill path until M2 PR3 unifies them.
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
import type { Workspace } from "../core/workspace/types";
import {
  type FileEntry,
  getIncrementalScanner,
} from "../utils/incremental-scanner";

interface BuildAgentToolRegistryOptions {
  sender: WebContents;
  taskId: string;
  workspace: Workspace;
  /** Restrict to this allow-list when set (skill `allowed-tools` frontmatter). */
  allowedTools?: string[];
}

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
}: BuildAgentToolRegistryOptions): ToolRegistry => {
  const registry = new ToolRegistry();
  const allow = (name: string): boolean =>
    !allowedTools || allowedTools.includes(name);

  for (const def of buildFileTools({ incrementalScanner: wrapScanner() })) {
    if (allow(def.name)) registry.register(def);
  }

  if (allow("askClarification")) {
    registry.register(askClarificationTool(sender, taskId));
  }

  return registry;
};
