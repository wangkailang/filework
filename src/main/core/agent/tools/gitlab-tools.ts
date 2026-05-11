/**
 * Native GitLab query / comment tools — `gitlabListMergeRequests`,
 * `gitlabGetMergeRequest`, `gitlabListIssues`, `gitlabGetIssue`,
 * `gitlabCommentIssue`, `gitlabCommentMergeRequest`, `gitlabSearchCode`.
 *
 * Mirrors `github-tools.ts` but uses GitLab terminology. The wrapped
 * methods are vendor-neutral (`workspace.scm.listPullRequests`, etc.) —
 * the same data shape works for GitHub PRs and GitLab MRs because
 * `GitLabWorkspaceSCM` projects MR `iid` to `PullRequestSummary.number`.
 *
 * Approval semantics (see `ipc/ai-tools.ts:ALWAYS_PROMPT_TOOLS`):
 *   - read tools (`safety: "safe"`) are never gated
 *   - `gitlabCommentIssue` and `gitlabCommentMergeRequest` are
 *     destructive AND always re-prompt (no whitelisting)
 */

import { z } from "zod/v4";

import type { WorkspaceSCM } from "../../workspace/types";
import type { ToolContext, ToolDefinition } from "../tool-registry";

const stateSchema = z.enum(["open", "closed", "all"]).optional();

const listMergeRequestsSchema = z.object({
  state: stateSchema.describe("Filter by state. Default: open."),
  base: z
    .string()
    .optional()
    .describe("Filter by target branch (e.g. 'main')."),
  head: z.string().optional().describe("Filter by source branch."),
});

const getMergeRequestSchema = z.object({
  number: z.number().int().positive().describe("MR iid (the !N number)"),
});

const listIssuesSchema = z.object({
  state: stateSchema.describe("Filter by state. Default: open."),
  labels: z
    .array(z.string())
    .optional()
    .describe("Match issues with all of these labels (AND-matched)."),
});

const getIssueSchema = z.object({
  number: z.number().int().positive().describe("Issue iid (the #N number)"),
});

const commentIssueSchema = z.object({
  number: z.number().int().positive().describe("Issue iid"),
  body: z
    .string()
    .min(1, "comment body is required")
    .describe("Markdown body of the note"),
});

const commentMergeRequestSchema = z.object({
  number: z.number().int().positive().describe("MR iid"),
  body: z
    .string()
    .min(1, "comment body is required")
    .describe("Markdown body of the conversation note"),
});

const searchCodeSchema = z.object({
  query: z
    .string()
    .min(1, "search query is required")
    .describe("GitLab blob search query, scoped to this project."),
});

const listPipelinesSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("Branch name to filter pipelines (e.g. 'main')."),
  status: z
    .enum(["all", "in_progress", "completed"])
    .optional()
    .describe(
      "Lifecycle filter. 'in_progress' maps to GitLab 'running'; 'completed' maps to 'success' (deliberate simplification — re-query for failed/canceled).",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Hard cap 100; older pipelines require a narrower filter."),
});

const getPipelineSchema = z.object({
  id: z
    .string()
    .min(1, "pipeline id is required")
    .describe(
      "Pipeline id (numeric, kept as string for symmetry with GitHub).",
    ),
});

const listPipelineJobsSchema = z.object({
  runId: z
    .string()
    .min(1, "runId is required")
    .describe("Pipeline id whose jobs you want."),
});

const getJobLogSchema = z.object({
  jobId: z
    .string()
    .min(1, "jobId is required")
    .describe("Job id whose trace you want."),
  lastLines: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      "Trailing line count. 0 = unbounded (still capped at 5000). Default 500.",
    ),
});

const retryPipelineSchema = z.object({
  runId: z
    .string()
    .min(1, "runId is required")
    .describe("Pipeline id to retry (failed jobs only)."),
});

const reviewMergeRequestSchema = z.object({
  number: z.number().int().positive().describe("MR iid"),
  body: z.string().optional().describe("Optional review-level summary note"),
  comments: z
    .array(
      z.object({
        path: z.string().min(1).describe("Workspace-relative file path"),
        line: z
          .number()
          .int()
          .min(1)
          .describe("1-based new-file line for the inline comment"),
        body: z.string().min(1).describe("Markdown body of the inline comment"),
      }),
    )
    .optional()
    .describe("Inline positional discussions. Empty array allowed."),
});

const listCommitStatusesSchema = z.object({
  sha: z.string().min(1, "commit sha is required").describe("Full commit sha"),
});

const cancelPipelineSchema = z.object({
  runId: z
    .string()
    .min(1, "runId is required")
    .describe("Pipeline id to cancel."),
});

const createPipelineSchema = z.object({
  ref: z
    .string()
    .min(1, "ref is required")
    .describe("Branch or tag the new pipeline runs on."),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe("CI variables, env_var type (e.g. {ENV: 'staging'})."),
});

const requireScm = <K extends keyof WorkspaceSCM>(
  ctx: ToolContext,
  method: K,
): NonNullable<WorkspaceSCM[K]> => {
  const fn = ctx.workspace.scm?.[method];
  if (typeof fn !== "function") {
    throw new Error(
      `Workspace does not support ${String(method)} (only GitLab workspaces do)`,
    );
  }
  return fn as NonNullable<WorkspaceSCM[K]>;
};

export const gitlabListMergeRequestsTool: ToolDefinition<
  z.infer<typeof listMergeRequestsSchema>,
  unknown
> = {
  name: "gitlabListMergeRequests",
  description:
    "List merge requests on the current GitLab project. Returns up to 100 results. Filter by state ('open'|'closed'|'all'), target branch, or source branch. State 'merged' is derived from merged_at.",
  safety: "safe",
  inputSchema: listMergeRequestsSchema,
  execute: async (args, ctx) => requireScm(ctx, "listPullRequests")(args),
};

export const gitlabGetMergeRequestTool: ToolDefinition<
  z.infer<typeof getMergeRequestSchema>,
  unknown
> = {
  name: "gitlabGetMergeRequest",
  description:
    "Fetch a single MR by iid. Returns title, description, source/target branches, mergeable, additions/deletions, and timestamps.",
  safety: "safe",
  inputSchema: getMergeRequestSchema,
  execute: async (args, ctx) => requireScm(ctx, "getPullRequest")(args),
};

export const gitlabListIssuesTool: ToolDefinition<
  z.infer<typeof listIssuesSchema>,
  unknown
> = {
  name: "gitlabListIssues",
  description:
    "List issues on the current GitLab project. Returns up to 100 results. Unlike GitHub, GitLab keeps issues and MRs separate so no filtering is needed.",
  safety: "safe",
  inputSchema: listIssuesSchema,
  execute: async (args, ctx) => requireScm(ctx, "listIssues")(args),
};

export const gitlabGetIssueTool: ToolDefinition<
  z.infer<typeof getIssueSchema>,
  unknown
> = {
  name: "gitlabGetIssue",
  description:
    "Fetch a single issue by iid. Returns title, description, labels, state, and timestamps.",
  safety: "safe",
  inputSchema: getIssueSchema,
  execute: async (args, ctx) => requireScm(ctx, "getIssue")(args),
};

export const gitlabCommentIssueTool: ToolDefinition<
  z.infer<typeof commentIssueSchema>,
  unknown
> = {
  name: "gitlabCommentIssue",
  description:
    "Post a note on an issue. Always requires explicit user approval (never auto-approved). Returns {commentId, url}.",
  safety: "destructive",
  inputSchema: commentIssueSchema,
  execute: async (args, ctx) => requireScm(ctx, "commentIssue")(args),
};

export const gitlabCommentMergeRequestTool: ToolDefinition<
  z.infer<typeof commentMergeRequestSchema>,
  unknown
> = {
  name: "gitlabCommentMergeRequest",
  description:
    "Post a conversation note on a merge request. For line-level review comments, a separate API would be needed (not exposed). Always requires explicit user approval.",
  safety: "destructive",
  inputSchema: commentMergeRequestSchema,
  execute: async (args, ctx) => requireScm(ctx, "commentPullRequest")(args),
};

export const gitlabSearchCodeTool: ToolDefinition<
  z.infer<typeof searchCodeSchema>,
  unknown
> = {
  name: "gitlabSearchCode",
  description:
    "Search code in the current GitLab project (blob search, scoped to this project). Returns up to 100 hits with file path + URL. Note: newly-pushed code may take a few minutes to appear in the search index.",
  safety: "safe",
  inputSchema: searchCodeSchema,
  execute: async (args, ctx) => requireScm(ctx, "searchCode")(args),
};

export const gitlabListPipelinesTool: ToolDefinition<
  z.infer<typeof listPipelinesSchema>,
  unknown
> = {
  name: "gitlabListPipelines",
  description:
    "List GitLab CI pipelines for the current project. Filter by branch (`ref`) or status (in_progress/completed/all). Returns up to 100 results sorted newest-first with conclusion and head commit.",
  safety: "safe",
  inputSchema: listPipelinesSchema,
  execute: async (args, ctx) => requireScm(ctx, "listCIRuns")(args),
};

export const gitlabGetPipelineTool: ToolDefinition<
  z.infer<typeof getPipelineSchema>,
  unknown
> = {
  name: "gitlabGetPipeline",
  description:
    "Fetch a single pipeline by id. Returns conclusion, runtime in seconds, head commit, and trigger source.",
  safety: "safe",
  inputSchema: getPipelineSchema,
  execute: async (args, ctx) => requireScm(ctx, "getCIRun")(args),
};

export const gitlabListPipelineJobsTool: ToolDefinition<
  z.infer<typeof listPipelineJobsSchema>,
  unknown
> = {
  name: "gitlabListPipelineJobs",
  description:
    "List jobs for a GitLab pipeline. `failedSteps` is always empty (GitLab's job-list endpoint doesn't expose step status — full traces require log fetching, deferred).",
  safety: "safe",
  inputSchema: listPipelineJobsSchema,
  execute: async (args, ctx) => requireScm(ctx, "listCIJobs")(args),
};

export const gitlabGetJobLogTool: ToolDefinition<
  z.infer<typeof getJobLogSchema>,
  unknown
> = {
  name: "gitlabGetJobLog",
  description:
    "Fetch the trace (log output) of a GitLab CI job. Returns the last 500 lines by default; pass lastLines=0 for unbounded (capped at 5000). Includes totalLines + truncated flag.",
  safety: "safe",
  inputSchema: getJobLogSchema,
  execute: async (args, ctx) => requireScm(ctx, "getCIJobLog")(args),
};

export const gitlabRetryPipelineTool: ToolDefinition<
  z.infer<typeof retryPipelineSchema>,
  unknown
> = {
  name: "gitlabRetryPipeline",
  description:
    "Retry a GitLab pipeline (re-runs only failed jobs). GitLab does not expose a 'full re-run' API — for that, create a new pipeline on the same ref via the GitLab UI. Always requires explicit user approval.",
  safety: "destructive",
  inputSchema: retryPipelineSchema,
  execute: async (args, ctx) =>
    requireScm(ctx, "rerunCI")({ runId: args.runId, failedOnly: true }),
};

export const gitlabReviewMergeRequestTool: ToolDefinition<
  z.infer<typeof reviewMergeRequestSchema>,
  unknown
> = {
  name: "gitlabReviewMergeRequest",
  description:
    "Submit a review on a merge request. Posts inline positional discussions for each comment + optional summary note. GitLab has no APPROVE/REQUEST_CHANGES verdict at this layer — use the dedicated approve API separately. Always requires explicit user approval.",
  safety: "destructive",
  inputSchema: reviewMergeRequestSchema,
  execute: async (args, ctx) => requireScm(ctx, "reviewPullRequest")(args),
};

export const gitlabListCommitStatusesTool: ToolDefinition<
  z.infer<typeof listCommitStatusesSchema>,
  unknown
> = {
  name: "gitlabListCommitStatuses",
  description:
    "List all build statuses for a commit sha — equivalent to GitHub's check-runs API. Returns name, status, conclusion, and url for each status reporter.",
  safety: "safe",
  inputSchema: listCommitStatusesSchema,
  execute: async (args, ctx) => requireScm(ctx, "listCommitChecks")(args),
};

export const gitlabCancelPipelineTool: ToolDefinition<
  z.infer<typeof cancelPipelineSchema>,
  unknown
> = {
  name: "gitlabCancelPipeline",
  description:
    "Cancel a GitLab CI pipeline that is still running. Idempotent — calling on an already-finished pipeline surfaces the GitLab error verbatim. Requires explicit user approval the first time per task; auto-approved on repeat.",
  safety: "destructive",
  inputSchema: cancelPipelineSchema,
  execute: async (args, ctx) => requireScm(ctx, "cancelCI")(args),
};

export const gitlabCreatePipelineTool: ToolDefinition<
  z.infer<typeof createPipelineSchema>,
  unknown
> = {
  name: "gitlabCreatePipeline",
  description:
    "Create a new GitLab CI pipeline on a ref with optional variables — analog to GitHub's workflow_dispatch but always synchronously returns the new pipeline id. Note: GitLab pipelines run all jobs whose rules match the ref (no per-workflow filter). Always requires explicit user approval. After approval the pipeline is auto-watched; you'll see a 🔔 message in chat when it finishes.",
  safety: "destructive",
  inputSchema: createPipelineSchema,
  execute: async (args, ctx) => requireScm(ctx, "createCIPipeline")(args),
};

/** All gitlab tools, in registration order. */
export const buildGitlabTools = (): ToolDefinition[] => [
  gitlabListMergeRequestsTool as ToolDefinition,
  gitlabGetMergeRequestTool as ToolDefinition,
  gitlabListIssuesTool as ToolDefinition,
  gitlabGetIssueTool as ToolDefinition,
  gitlabCommentIssueTool as ToolDefinition,
  gitlabCommentMergeRequestTool as ToolDefinition,
  gitlabSearchCodeTool as ToolDefinition,
  gitlabListPipelinesTool as ToolDefinition,
  gitlabGetPipelineTool as ToolDefinition,
  gitlabListPipelineJobsTool as ToolDefinition,
  gitlabGetJobLogTool as ToolDefinition,
  gitlabRetryPipelineTool as ToolDefinition,
  gitlabReviewMergeRequestTool as ToolDefinition,
  gitlabListCommitStatusesTool as ToolDefinition,
  gitlabCancelPipelineTool as ToolDefinition,
  gitlabCreatePipelineTool as ToolDefinition,
];
