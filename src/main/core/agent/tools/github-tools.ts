/**
 * Native GitHub query / comment tools — `githubListPullRequests`,
 * `githubGetPullRequest`, `githubListIssues`, `githubGetIssue`,
 * `githubCommentIssue`, `githubCommentPullRequest`, `githubSearchCode`.
 *
 * Wraps the optional `WorkspaceSCM.list*` / `get*` / `comment*` /
 * `searchCode` methods (currently implemented only by `GitHubWorkspace`).
 * The PAT comes from the workspace ref's credentialId — no per-call
 * credential picking. All read tools are `safety: "safe"`; comment tools
 * are `safety: "destructive"` and listed in `ALWAYS_PROMPT_TOOLS` so they
 * re-prompt every invocation.
 *
 * Pagination: hard-cap at 100 results (matches `github:listRepos` from
 * M6 PR 1). Heavy users can re-query with narrower filters.
 */

import { z } from "zod/v4";

import type { WorkspaceSCM } from "../../workspace/types";
import type { ToolContext, ToolDefinition } from "../tool-registry";

const stateSchema = z.enum(["open", "closed", "all"]).optional();

const listPullRequestsSchema = z.object({
  state: stateSchema.describe("Filter by state. Default: open."),
  base: z.string().optional().describe("Filter by base branch (e.g. 'main')."),
  head: z
    .string()
    .optional()
    .describe("Filter by head branch (`user:branch` for cross-fork)."),
});

const getPullRequestSchema = z.object({
  number: z.number().int().positive().describe("PR number"),
});

const listIssuesSchema = z.object({
  state: stateSchema.describe("Filter by state. Default: open."),
  labels: z
    .array(z.string())
    .optional()
    .describe("Match issues with all of these labels."),
});

const getIssueSchema = z.object({
  number: z.number().int().positive().describe("Issue number"),
});

const commentIssueSchema = z.object({
  number: z.number().int().positive().describe("Issue number"),
  body: z
    .string()
    .min(1, "comment body is required")
    .describe("Markdown body of the comment"),
});

const commentPullRequestSchema = z.object({
  number: z.number().int().positive().describe("PR number"),
  body: z
    .string()
    .min(1, "comment body is required")
    .describe("Markdown body of the conversation comment"),
});

const searchCodeSchema = z.object({
  query: z
    .string()
    .min(1, "search query is required")
    .describe(
      "GitHub code search query. The repo: qualifier is appended automatically.",
    ),
});

const listWorkflowRunsSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("Branch name to filter runs (e.g. 'main')."),
  status: z
    .enum(["all", "in_progress", "completed"])
    .optional()
    .describe("Filter by lifecycle phase."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Hard cap 100; older runs require a narrower filter."),
});

const getWorkflowRunSchema = z.object({
  id: z
    .string()
    .min(1, "workflow run id is required")
    .describe("Workflow run id (string; GitHub ids exceed 32-bit)."),
});

const listWorkflowRunJobsSchema = z.object({
  runId: z
    .string()
    .min(1, "runId is required")
    .describe("Workflow run id whose jobs you want."),
});

const requireScm = <K extends keyof WorkspaceSCM>(
  ctx: ToolContext,
  method: K,
): NonNullable<WorkspaceSCM[K]> => {
  const fn = ctx.workspace.scm?.[method];
  if (typeof fn !== "function") {
    throw new Error(
      `Workspace does not support ${String(method)} (only GitHub workspaces do)`,
    );
  }
  return fn as NonNullable<WorkspaceSCM[K]>;
};

export const githubListPullRequestsTool: ToolDefinition<
  z.infer<typeof listPullRequestsSchema>,
  unknown
> = {
  name: "githubListPullRequests",
  description:
    "List pull requests on the current GitHub repo. Returns up to 100 results sorted newest-first. Filter by state ('open'|'closed'|'all'), base branch, or head branch.",
  safety: "safe",
  inputSchema: listPullRequestsSchema,
  execute: async (args, ctx) => requireScm(ctx, "listPullRequests")(args),
};

export const githubGetPullRequestTool: ToolDefinition<
  z.infer<typeof getPullRequestSchema>,
  unknown
> = {
  name: "githubGetPullRequest",
  description:
    "Fetch a single PR by number. Returns title, body, head/base, mergeable, additions/deletions, and timestamps. State 'merged' is derived from merged_at.",
  safety: "safe",
  inputSchema: getPullRequestSchema,
  execute: async (args, ctx) => requireScm(ctx, "getPullRequest")(args),
};

export const githubListIssuesTool: ToolDefinition<
  z.infer<typeof listIssuesSchema>,
  unknown
> = {
  name: "githubListIssues",
  description:
    "List issues on the current GitHub repo (PRs are filtered out). Returns up to 100 results. Filter by state and/or labels.",
  safety: "safe",
  inputSchema: listIssuesSchema,
  execute: async (args, ctx) => requireScm(ctx, "listIssues")(args),
};

export const githubGetIssueTool: ToolDefinition<
  z.infer<typeof getIssueSchema>,
  unknown
> = {
  name: "githubGetIssue",
  description:
    "Fetch a single issue by number. Returns title, body, labels, state, and timestamps.",
  safety: "safe",
  inputSchema: getIssueSchema,
  execute: async (args, ctx) => requireScm(ctx, "getIssue")(args),
};

export const githubCommentIssueTool: ToolDefinition<
  z.infer<typeof commentIssueSchema>,
  unknown
> = {
  name: "githubCommentIssue",
  description:
    "Post a comment on an issue. Always requires explicit user approval (never auto-approved). Returns {commentId, url}.",
  safety: "destructive",
  inputSchema: commentIssueSchema,
  execute: async (args, ctx) => requireScm(ctx, "commentIssue")(args),
};

export const githubCommentPullRequestTool: ToolDefinition<
  z.infer<typeof commentPullRequestSchema>,
  unknown
> = {
  name: "githubCommentPullRequest",
  description:
    "Post a conversation comment on a PR. Hits the same endpoint as githubCommentIssue (GitHub treats PR conversation comments as issue comments). For line-level review comments, a separate API would be needed (not exposed). Always requires explicit user approval.",
  safety: "destructive",
  inputSchema: commentPullRequestSchema,
  execute: async (args, ctx) => requireScm(ctx, "commentPullRequest")(args),
};

export const githubSearchCodeTool: ToolDefinition<
  z.infer<typeof searchCodeSchema>,
  unknown
> = {
  name: "githubSearchCode",
  description:
    "Search code in the current GitHub repo. The query is auto-scoped with `repo:owner/name`. Returns up to 100 hits with file path + URL. Note: newly-pushed code may take a few minutes to appear in the search index.",
  safety: "safe",
  inputSchema: searchCodeSchema,
  execute: async (args, ctx) => requireScm(ctx, "searchCode")(args),
};

export const githubListWorkflowRunsTool: ToolDefinition<
  z.infer<typeof listWorkflowRunsSchema>,
  unknown
> = {
  name: "githubListWorkflowRuns",
  description:
    "List GitHub Actions workflow runs for the current repo. Filter by branch (`ref`) or status (in_progress/completed/all). Returns up to 100 results sorted newest-first with conclusion and head commit.",
  safety: "safe",
  inputSchema: listWorkflowRunsSchema,
  execute: async (args, ctx) => requireScm(ctx, "listCIRuns")(args),
};

export const githubGetWorkflowRunTool: ToolDefinition<
  z.infer<typeof getWorkflowRunSchema>,
  unknown
> = {
  name: "githubGetWorkflowRun",
  description:
    "Fetch a single workflow run by id. Returns conclusion, runtime in seconds, head commit, and jobs count.",
  safety: "safe",
  inputSchema: getWorkflowRunSchema,
  execute: async (args, ctx) => requireScm(ctx, "getCIRun")(args),
};

export const githubListWorkflowRunJobsTool: ToolDefinition<
  z.infer<typeof listWorkflowRunJobsSchema>,
  unknown
> = {
  name: "githubListWorkflowRunJobs",
  description:
    "List jobs for a workflow run. Each job exposes its conclusion and (on failure) the names of failing steps.",
  safety: "safe",
  inputSchema: listWorkflowRunJobsSchema,
  execute: async (args, ctx) => requireScm(ctx, "listCIJobs")(args),
};

/** All github tools, in registration order. */
export const buildGithubTools = (): ToolDefinition[] => [
  githubListPullRequestsTool as ToolDefinition,
  githubGetPullRequestTool as ToolDefinition,
  githubListIssuesTool as ToolDefinition,
  githubGetIssueTool as ToolDefinition,
  githubCommentIssueTool as ToolDefinition,
  githubCommentPullRequestTool as ToolDefinition,
  githubSearchCodeTool as ToolDefinition,
  githubListWorkflowRunsTool as ToolDefinition,
  githubGetWorkflowRunTool as ToolDefinition,
  githubListWorkflowRunJobsTool as ToolDefinition,
];
