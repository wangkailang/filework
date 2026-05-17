/**
 * Eval-mode `ToolRegistry` builder.
 *
 * The production `buildAgentToolRegistry` pulls in IPC-coupled bits
 * (`WebContents`, `ciWatcher`, `askClarification`, etc.) and registers
 * Electron-only tools (`webFetchRendered`, `browserOpen` and friends).
 * The CLI harness needs none of that — it runs as a plain Node process
 * with no renderer attached.
 *
 * We register a deliberately narrow subset that's enough for GAIA L1/L2
 * file + web + tool-use questions:
 *
 *   - File tools (read/write/list/move/delete/runCommand/...)
 *   - webFetch (always — only needs `fetch`)
 *   - webSearch (when `TAVILY_API_KEY` is set)
 *   - webScrape (when `FIRECRAWL_API_KEY` is set)
 *   - youtubeTranscript (always — no auth needed)
 *   - Skills (pdf / docx / xlsx / pptx) — flattened from `skills[].tools`
 *
 * Out of scope for v1: interactive browser tools (need Electron),
 * GitHub / GitLab tools (need workspace SCM), `askClarification`
 * (needs an IPC sender). A question that requires one of these will
 * be tagged in the failure summary.
 *
 * Tools with `safety: "destructive"` (writeFile, runCommand, …) run
 * UNCONDITIONALLY in eval mode. `runCommand` in particular is required
 * for L1 calculation questions; gating it on user approval would
 * defeat the purpose of an autonomous benchmark.
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
  /** Plain `fetch` — proxy-aware fetch is renderer-process scoped. */
  fetchImpl: typeof fetch;
  /** Read from env: `process.env.TAVILY_API_KEY`. */
  tavilyKey?: string | null;
  /** Read from env: `process.env.FIRECRAWL_API_KEY`. */
  firecrawlKey?: string | null;
}

// ─── Tool result size cap ────────────────────────────────────────────

/**
 * Maximum serialised JSON size of any single tool result. Beyond this,
 * long string fields are individually truncated.
 *
 * Why: a webFetch that returns 200KB of markdown, replayed across 12
 * turns, is 2.4MB of input tokens. The first GAIA smoke run hit 9M
 * input tokens on a single stuck question for exactly this reason.
 * Capping per-result bounds the worst case to a few hundred KB of
 * conversation history.
 */
const TOOL_RESULT_CAP_BYTES = 30_000;
/** When the result is over the cap, individual strings get clipped to this. */
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
 * Cap a tool result: returns the original when small, or a deeply-
 * cloned-and-truncated version when serialised size exceeds the cap.
 * Strings shorter than {@link STRING_LEAF_CAP_BYTES} pass through
 * untouched even on the over-cap path — only the long ones get clipped.
 *
 * Exported for unit tests.
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
  // JSON.stringify returns `undefined` for `undefined` and functions —
  // both are terminal and far under the cap.
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
 * Wrap a skill's loose-shaped tool (typed as ai-sdk's `Tool`) into our
 * `ToolDefinition` form so it can join the registry alongside the
 * core tools. Skill tools are always treated as `safe`; their bodies
 * already validate inputs via the embedded Zod schema.
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

  // Core file tools — no scanner; eval workspaces are small per-question.
  for (const def of buildFileTools()) register(def);

  // Web stack (the renderer-only ones are skipped).
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

  // Skill tools — always include every built-in (pdf/docx/xlsx/pptx,
  // plus the analytical ones like report-generator). The model picks
  // whichever is relevant.
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
 * Build a `ToolContext` factory for the registry. Exported so
 * `runner.ts` can wire it without depending on Workspace import paths
 * directly.
 */
export const evalContextFactory =
  (workspace: Workspace, signal: AbortSignal) =>
  (call: { toolName: string; toolCallId: string }) => ({
    workspace,
    signal,
    toolCallId: call.toolCallId,
  });
