/**
 * Typed git tools — `gitCommit`, `gitPush`, `openPullRequest`.
 *
 * These wrap the optional `WorkspaceSCM.commit/push/openPullRequest`
 * methods (currently implemented only by `GitHubWorkspace`). Each tool
 * is `safety: "destructive"` and routes through the existing
 * `beforeToolCall` approval hook. Auto-branching per chat session is
 * enforced by the SCM implementation, so the agent never needs to
 * reason about branch names — the tools always commit/push/open against
 * the current `claude/<scope>` branch.
 *
 * Approval semantics (see `ipc/approval-hook.ts`):
 *   - `gitCommit` whitelists for the rest of the task after first ok
 *     (matches `writeFile` ergonomics; users won't be prompted on every
 *     commit during a chained refactor).
 *   - `gitPush` and `openPullRequest` always prompt — they touch the
 *     remote and are explicitly excluded from the whitelist path.
 */

import { z } from "zod/v4";

import type { ToolDefinition } from "../tool-registry";

const gitCommitSchema = z.object({
  message: z
    .string()
    .min(1, "commit message is required")
    .describe("Commit message (first line becomes the subject)"),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Workspace-relative paths to stage. Omit to stage all changes (`git add -A`).",
    ),
});

const gitPushSchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Use `--force-with-lease` (never raw `--force`). Default false."),
});

const openPullRequestSchema = z.object({
  title: z
    .string()
    .min(1, "PR title is required")
    .describe("Short title shown in the PR list"),
  body: z
    .string()
    .optional()
    .describe("PR body in markdown. Defaults to empty."),
  draft: z.boolean().optional().describe("Open as a draft PR. Default false."),
  base: z
    .string()
    .optional()
    .describe(
      "Target branch on the remote. Defaults to the workspace ref the user opened.",
    ),
});

export const gitCommitTool: ToolDefinition<
  z.infer<typeof gitCommitSchema>,
  unknown
> = {
  name: "gitCommit",
  description:
    "Stage files and create a git commit on the current session branch. The session branch (claude/<scope>) is auto-created off the workspace ref on first use. Returns {sha, branch, filesChanged}; sha is empty when there is nothing to commit. Requires user approval.",
  safety: "destructive",
  inputSchema: gitCommitSchema,
  execute: async (args, ctx) => {
    if (!ctx.workspace.scm?.commit) {
      throw new Error(
        "Workspace does not support gitCommit (only GitHub workspaces do)",
      );
    }
    return ctx.workspace.scm.commit(args);
  },
};

export const gitPushTool: ToolDefinition<
  z.infer<typeof gitPushSchema>,
  unknown
> = {
  name: "gitPush",
  description:
    "Push the current session branch to origin. Sets upstream on first push. Requires user approval (always prompts — never auto-approved).",
  safety: "destructive",
  inputSchema: gitPushSchema,
  execute: async (args, ctx) => {
    if (!ctx.workspace.scm?.push) {
      throw new Error(
        "Workspace does not support gitPush (only GitHub workspaces do)",
      );
    }
    return ctx.workspace.scm.push(args);
  },
};

export const openPullRequestTool: ToolDefinition<
  z.infer<typeof openPullRequestSchema>,
  unknown
> = {
  name: "openPullRequest",
  description:
    "Open a pull request from the session branch to `base` (defaults to the workspace ref). Returns {url, number}. Requires user approval (always prompts — never auto-approved). Call gitPush first.",
  safety: "destructive",
  inputSchema: openPullRequestSchema,
  execute: async (args, ctx) => {
    if (!ctx.workspace.scm?.openPullRequest) {
      throw new Error(
        "Workspace does not support openPullRequest (only GitHub workspaces do)",
      );
    }
    return ctx.workspace.scm.openPullRequest(args);
  },
};

/** All git tools, in registration order. */
export const buildGitTools = (): ToolDefinition[] => [
  gitCommitTool as ToolDefinition,
  gitPushTool as ToolDefinition,
  openPullRequestTool as ToolDefinition,
];
