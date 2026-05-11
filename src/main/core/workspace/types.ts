/**
 * Workspace abstraction.
 *
 * A Workspace represents the addressable surface that Agent tools operate
 * on. The current implementation (`LocalWorkspace`) is a directory on disk;
 * future implementations will back the same interface with a remote source
 * such as a GitHub or GitLab repository (cloned ephemerally to a local cache).
 *
 * Tools take workspace-relative paths via `WorkspaceFS`. Implementations
 * enforce sandboxing — `toRelative()` must throw `WorkspaceEscapeError`
 * for any absolute path that resolves outside the workspace root.
 */

export type WorkspaceKind = "local" | "github" | "gitlab" | "gitea";

export interface WorkspaceEntry {
  name: string;
  /** Workspace-relative POSIX-style path. */
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

export interface ReadFileOptions {
  encoding?: "utf-8" | "binary";
}

export interface ListOptions {
  recursive?: boolean;
  includeStats?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
}

export interface ExecOptions {
  /** Workspace-relative cwd. Defaults to workspace root. */
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileStat {
  size: number;
  mtime: Date;
  isDirectory: boolean;
}

/**
 * Filesystem-like surface a Workspace exposes to tools. Paths are
 * workspace-relative; implementations resolve them against their root
 * and enforce that the resolved location stays inside.
 */
export interface WorkspaceFS {
  readFile(rel: string, opts?: ReadFileOptions): Promise<string | Uint8Array>;
  writeFile(rel: string, content: string | Uint8Array): Promise<void>;
  exists(rel: string): Promise<boolean>;
  stat(rel: string): Promise<FileStat>;
  list(rel: string, opts?: ListOptions): Promise<WorkspaceEntry[]>;
  mkdir(rel: string, opts?: MkdirOptions): Promise<void>;
  rm(rel: string, opts?: RmOptions): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  /** Resolve a workspace-relative path to an implementation-specific absolute form. */
  resolve(rel: string): string;
  /**
   * Convert an absolute path to its workspace-relative form. Throws
   * {@link WorkspaceEscapeError} when the path resolves outside the
   * workspace root.
   */
  toRelative(abs: string): Promise<string>;
}

export interface WorkspaceExec {
  run(command: string, opts?: ExecOptions): Promise<ExecResult>;
}

// ---------------------------------------------------------------------------
// SCM result projections
//
// Stable, narrow projections of provider-specific shapes (GitHub REST today;
// GitLab tomorrow). Tools and the renderer talk in these types, never the
// raw API responses, so swapping providers doesn't ripple through the agent.
// ---------------------------------------------------------------------------

export interface PullRequestSummary {
  number: number;
  title: string;
  /** "merged" is derived: GitHub returns `closed` + `merged_at != null`. */
  state: "open" | "closed" | "merged";
  url: string;
  head: string;
  base: string;
  user: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  /** `null` while GitHub's merge check is in flight. */
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  mergedAt: string | null;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  user: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  closedAt: string | null;
}

export interface CodeSearchHit {
  name: string;
  path: string;
  /** "owner/name" — useful when results are cross-repo. */
  repo: string;
  htmlUrl: string;
}

export interface CodeSearchResult {
  totalCount: number;
  items: CodeSearchHit[];
}

// ---------------------------------------------------------------------------
// CI / pipeline status (M8). Vendor-neutral projections of GitHub Actions
// workflow runs and GitLab pipelines. Same union for both providers so the
// agent's mental model is consistent.
// ---------------------------------------------------------------------------

export type CIRunStatus = "queued" | "in_progress" | "completed";

export type CIRunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "timed_out"
  | "action_required"
  | null; // null while still in_progress

export interface CIRunSummary {
  /** Provider-native run id, kept as string for symmetry across providers. */
  id: string;
  /** Workflow / pipeline name (or short title). */
  name: string;
  status: CIRunStatus;
  /** null while in_progress; populated on completed. */
  conclusion: CIRunConclusion;
  /** Branch the run was triggered for. */
  ref: string;
  /** Head commit sha. */
  commitSha: string;
  url: string;
  startedAt: string;
  completedAt: string | null;
}

export interface CIRunDetail extends CIRunSummary {
  /** Trigger event ("push", "pull_request", "schedule", …). */
  event: string;
  /** Total runtime in seconds; null while in_progress. */
  durationSec: number | null;
  /** Number of jobs in the run; may be 0 if not yet expanded. */
  jobsCount: number;
}

export interface CIJobSummary {
  id: string;
  name: string;
  status: CIRunStatus;
  conclusion: CIRunConclusion;
  url: string;
  startedAt: string;
  completedAt: string | null;
  /**
   * Names of failing steps (empty for green runs, non-empty for red).
   * GitLab impls leave this empty — step status isn't on the job-list
   * endpoint; full traces would require log-fetching, deferred.
   */
  failedSteps: string[];
}

/**
 * Raw log text for a single CI job (M9). Both providers return text/plain
 * from their respective log endpoints; we slice client-side because
 * neither API supports server-side line-range queries.
 */
export interface CIJobLog {
  jobId: string;
  /** Full log or the last `lastLines` lines if a tail was requested. */
  content: string;
  /** Total line count of the original log, regardless of slicing. */
  totalLines: number;
  /** True when content is a tail slice rather than the full log. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// PR / MR review (M10) + combined commit checks. Review semantics differ
// across providers — verdict is GitHub-native; GitLab implementations
// ignore it. CommitCheck unifies GitHub Actions + 3rd-party check-runs and
// GitLab build statuses behind one shape.
// ---------------------------------------------------------------------------

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PullRequestReviewComment {
  /** Workspace-relative file path. */
  path: string;
  /** 1-based line number on the right side of the diff (the "new" file). */
  line: number;
  /** Markdown body of the inline comment. */
  body: string;
}

export interface PullRequestReviewInput {
  number: number;
  /** Optional review-level body posted alongside line comments. */
  body?: string;
  /** Inline line comments. Empty array allowed. */
  comments?: PullRequestReviewComment[];
  /**
   * Verdict — GitHub only. GitLab implementations ignore this field;
   * GitLab MRs have a separate Approve API that we don't expose here.
   */
  event?: ReviewVerdict;
}

export interface PullRequestReviewResult {
  /**
   * Provider-native review id. On GitHub this is the review's id. On
   * GitLab there is no aggregating "review" object — implementations
   * return the first discussion's id (or the body note's id when no
   * comments were posted).
   */
  reviewId: string;
  url: string;
}

/** Combined commit-level check status across all reporting providers. */
export interface CommitCheck {
  /** Combined check / status name (e.g. "ci/circleci: build", "build"). */
  name: string;
  status: CIRunStatus;
  conclusion: CIRunConclusion;
  url: string;
  /**
   * Reporting source: GitHub `app.slug` ("github-actions", "circleci"…).
   * GitLab returns "gitlab_ci" since the statuses endpoint doesn't tag
   * a per-status source app.
   */
  source: string;
}

/**
 * Lightweight workflow descriptor (M11). Agents call `listWorkflows` to
 * learn what `workflowFile` value to pass to `dispatchWorkflow` without
 * having to scrape `.github/workflows/`.
 */
export interface WorkflowSummary {
  /** Provider-native id (kept as string for symmetry with other M8+ ids). */
  id: string;
  /** Human-readable workflow name (from the `name:` field in the YAML). */
  name: string;
  /** Repo-relative path, e.g. ".github/workflows/ci.yml". */
  path: string;
  /** "active" / "disabled_inactivity" / "disabled_manually". */
  state: string;
}

/**
 * Source-control surface. Optional: only Git-backed workspaces implement it.
 * `LocalWorkspace` does not implement this in M1. Every method is optional
 * so backends can opt into a subset (status/diff in M6 PR 1; commit/push/PR
 * in M6 PR 2; query + comment in M6 PR 3; CI runs in M8 — all github/gitlab
 * backed today).
 */
export interface WorkspaceSCM {
  status?(): Promise<{ branch: string; dirty: boolean }>;
  diff?(rel?: string): Promise<string>;
  /** Symbolic name of the currently checked-out branch. */
  currentBranch?(): Promise<string>;
  /**
   * Stage `files` (or all changes when omitted) and create a commit on
   * the current session branch. Implementations may auto-create the
   * session branch on first commit. A clean tree returns `{sha:""}` —
   * a friendly no-op rather than an error.
   */
  commit?(input: {
    message: string;
    /** Workspace-relative paths; if omitted, stages all changes. */
    files?: string[];
  }): Promise<{ sha: string; branch: string; filesChanged: number }>;
  /**
   * Push the current session branch to the remote. `force` maps to
   * `--force-with-lease` only — never raw `--force`.
   */
  push?(input?: {
    force?: boolean;
  }): Promise<{ branch: string; remote: string }>;
  /**
   * Open a pull request from the session branch to `base` (defaults to
   * the workspace ref). Returns the URL and number of the new PR.
   */
  openPullRequest?(input: {
    title: string;
    body?: string;
    draft?: boolean;
    base?: string;
  }): Promise<{ url: string; number: number }>;

  // ── M6 PR 3: native query / comment surface ───────────────────────────

  /** List PRs on the workspace's repo. Default state is `open`. */
  listPullRequests?(input?: {
    state?: "open" | "closed" | "all";
    base?: string;
    head?: string;
  }): Promise<PullRequestSummary[]>;

  /** Fetch a single PR by number. */
  getPullRequest?(input: { number: number }): Promise<PullRequestDetail>;

  /** List issues on the workspace's repo. PRs are filtered out. */
  listIssues?(input?: {
    state?: "open" | "closed" | "all";
    labels?: string[];
  }): Promise<IssueSummary[]>;

  /** Fetch a single issue by number. */
  getIssue?(input: { number: number }): Promise<IssueDetail>;

  /** Post a comment on an issue. Same endpoint as `commentPullRequest`. */
  commentIssue?(input: {
    number: number;
    body: string;
  }): Promise<{ commentId: number; url: string }>;

  /**
   * Post a conversation comment on a PR. GitHub treats PR conversation
   * comments as issue comments; this method aliases `commentIssue` for
   * the same repo. (Line-level review comments are a separate API not
   * covered here.)
   */
  commentPullRequest?(input: {
    number: number;
    body: string;
  }): Promise<{ commentId: number; url: string }>;

  /**
   * Search code within the workspace's repo. Implementations append a
   * `repo:owner/name` qualifier so results stay scoped to the workspace.
   */
  searchCode?(input: { query: string }): Promise<CodeSearchResult>;

  // ── M8: CI / pipeline status ──────────────────────────────────────────

  /**
   * List CI runs for the workspace's repo. `ref` filters by branch name;
   * `status` narrows by lifecycle phase. Hard cap is 100 results — agents
   * asking for more re-query with narrower filters.
   */
  listCIRuns?(input?: {
    ref?: string;
    status?: "all" | "in_progress" | "completed";
    limit?: number;
  }): Promise<CIRunSummary[]>;

  /** Fetch a single CI run by id. */
  getCIRun?(input: { id: string }): Promise<CIRunDetail>;

  /** List jobs for a CI run. */
  listCIJobs?(input: { runId: string }): Promise<CIJobSummary[]>;

  // ── M9: CI logs + re-run ─────────────────────────────────────────────

  /**
   * Fetch the raw log of a single CI job. Both providers return text/plain;
   * implementations slice client-side. `lastLines: 0` means unbounded
   * (still capped at 5000 to protect the agent's context budget); a
   * positive integer requests that many trailing lines. Default 500.
   */
  getCIJobLog?(input: { jobId: string; lastLines?: number }): Promise<CIJobLog>;

  /**
   * Re-trigger a CI run. `failedOnly: true` (default) re-runs only the
   * failed jobs of the run (cheaper). `failedOnly: false` re-runs the
   * entire run; on GitLab this throws — GitLab's `/retry` endpoint is
   * failed-only by API design.
   */
  rerunCI?(input: {
    runId: string;
    failedOnly?: boolean;
  }): Promise<{ runId: string; queued: boolean }>;

  // ── M10: PR review + commit checks ───────────────────────────────────

  /**
   * Submit a review on a PR/MR. One call posts N inline line-level
   * comments + an optional summary body + an optional verdict (GitHub
   * only). GitLab implementations sequence per-comment discussions and
   * ignore `event`.
   */
  reviewPullRequest?(
    input: PullRequestReviewInput,
  ): Promise<PullRequestReviewResult>;

  /**
   * List all checks for a commit sha. On GitHub this hits the combined
   * `/check-runs` endpoint (covers GitHub Actions + third-party providers
   * like CircleCI). On GitLab this hits the commit `statuses` endpoint.
   * Both project to the same vendor-neutral `CommitCheck` shape.
   */
  listCommitChecks?(input: { sha: string }): Promise<CommitCheck[]>;

  // ── M11: CI write — cancel + workflow_dispatch ───────────────────────

  /**
   * Cancel an in-progress CI run / pipeline. Idempotent — calling on an
   * already-terminal run surfaces the provider's friendly error
   * (HTTP 409 on GitHub) verbatim so the agent can re-check status.
   */
  cancelCI?(input: {
    runId: string;
  }): Promise<{ runId: string; cancelled: boolean }>;

  /**
   * List workflows declared in the repo's CI config. GitHub-only today —
   * `WorkflowSummary` is the lightweight descriptor of `.github/workflows/*.yml`.
   */
  listWorkflows?(): Promise<WorkflowSummary[]>;

  /**
   * Manually trigger a workflow with optional inputs. `workflowFile` is
   * either the workflow filename ("ci.yml") or its numeric id as string.
   * GitHub-only today; GitLab `POST /pipeline?ref=…` is "create new
   * pipeline on ref" (different semantics, deferred).
   */
  dispatchWorkflow?(input: {
    workflowFile: string;
    ref: string;
    inputs?: Record<string, string>;
  }): Promise<{ workflowFile: string; ref: string; queued: boolean }>;
}

export interface Workspace {
  /** Stable identifier, e.g. "local:/Users/kai/proj" or "github:org/repo@branch". */
  readonly id: string;
  readonly kind: WorkspaceKind;
  /** Implementation-specific root (absolute path for LocalWorkspace). */
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm?: WorkspaceSCM;
}

/**
 * Thrown by `WorkspaceFS.toRelative()` (and any tool that rejects out-of-
 * sandbox paths) when a caller attempts to operate outside the workspace.
 */
export class WorkspaceEscapeError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(
      `Path "${attemptedPath}" is outside workspace root "${workspaceRoot}"`,
    );
    this.name = "WorkspaceEscapeError";
  }
}
