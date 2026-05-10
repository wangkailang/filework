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

/**
 * Source-control surface. Optional: only Git-backed workspaces implement it.
 * `LocalWorkspace` does not implement this in M1. Every method is optional
 * so backends can opt into a subset (status/diff in M6 PR 1; commit/push/PR
 * in M6 PR 2; query + comment in M6 PR 3 — all github-backed only today).
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
