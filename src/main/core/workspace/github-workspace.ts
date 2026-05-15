/**
 * GitHubWorkspace — Workspace backed by an ephemeral local clone of a
 * GitHub repository.
 *
 * Layout: `<cacheDir>/<owner>/<repo>/` holds a single partial clone of
 * `https://github.com/<owner>/<repo>` (`--filter=blob:none` — all refs
 * available, blobs fetched on demand). Switching branches mutates this
 * same directory via `git checkout`, the same mental model as a local
 * git project. A sibling `.last-fetch` file timestamps the most recent
 * `git fetch` so freshness checks don't re-walk the working tree.
 *
 * After the clone is materialized, fs/exec are delegated to an internal
 * `LocalWorkspace` pointing at the clone — the existing tool registry
 * works without modification. M6 PR 1 added status/diff. M6 PR 2 adds
 * commit/push/openPullRequest, all gated through approval-hook.ts and
 * landing on a per-session branch (`claude/<sessionScope>`) auto-cut
 * from the workspace ref. Raw `git push`-style runCommand calls remain
 * refused — typed tools are the only sanctioned write path.
 *
 * Token handling: the PAT is injected into the remote URL the first
 * time we clone. Once the remote is set, we run `git fetch` without
 * exposing the token in argv (the URL on disk is the authentication
 * vector). Future hardening: switch to a `GIT_ASKPASS` helper to keep
 * the token out of the on-disk remote URL too.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkoutBranchTo, withCloneLock } from "./clone-cache";
import { buildAskpassEnv, githubSanitizedRemote } from "./git-credentials";
import { buildGitProxyEnv, type ProxyResolver } from "./git-proxy-env";
import { startHeadWatcher } from "./head-watcher";
import { LocalWorkspace } from "./local-workspace";
import type {
  CIJobLog,
  CIJobSummary,
  CIRunConclusion,
  CIRunDetail,
  CIRunStatus,
  CIRunSummary,
  CodeSearchResult,
  CommitCheck,
  ExecOptions,
  ExecResult,
  IssueDetail,
  IssueSummary,
  PullRequestDetail,
  PullRequestReviewCommentSummary,
  PullRequestReviewInput,
  PullRequestReviewResult,
  PullRequestSummary,
  WorkflowSummary,
  Workspace,
  WorkspaceExec,
  WorkspaceFS,
  WorkspaceKind,
  WorkspaceSCM,
} from "./types";
import { workspaceRefId } from "./workspace-ref";

export interface GitHubRef {
  kind: "github";
  owner: string;
  repo: string;
  ref: string;
  credentialId: string;
}

export interface GitHubWorkspaceDeps {
  /** Returns a decrypted PAT for the credential id. Throws if missing. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Root for ephemeral clones, e.g. `~/.filework/cache/github`. */
  cacheDir: string;
  /**
   * Absolute path to the GIT_ASKPASS helper script. Production wires
   * this from `git-credentials.ts:ensureAskpassScript()`. Tests can
   * leave it undefined — `runGit` falls back to plain spawn without
   * setting the env, which is fine because the test stub for `git`
   * never actually authenticates.
   */
  askpassPath?: string;
  /**
   * Clone freshness window in milliseconds. After this much time since
   * the last `git fetch`, GitHubWorkspace.create() refreshes before
   * returning. Defaults to 1 hour.
   */
  freshnessTtlMs?: number;
  /**
   * Override the spawn implementation in tests. Production code uses
   * the default `child_process.spawn`.
   */
  spawnFn?: typeof spawn;
  /**
   * Override the fetch implementation in tests (used for openPullRequest).
   * Defaults to globalThis.fetch.
   */
  fetchFn?: typeof fetch;
  /**
   * Per-host proxy resolver (Chromium PAC output: "DIRECT" / "PROXY h:p").
   * Wired by `index.ts` to `session.defaultSession.resolveProxy`. When set,
   * every network-touching git subprocess gets a freshly-built env where
   * HTTPS_PROXY matches the PAC verdict for the actual remote URL —
   * fixes split-routing setups where the global env proxy is wrong for
   * some hosts. Undefined falls back to inherited `process.env`.
   */
  resolveProxy?: ProxyResolver;
  /**
   * Per-session scope for auto-branching. Commits land on
   * `claude/<sessionScope>`. The factory passes `sessionId.slice(0,8)`
   * so the same chat session keeps committing to the same branch across
   * agent turns. If omitted, a stable token derived from the ref is used.
   */
  sessionScope?: string;
}

/**
 * Build the env to pass to `runGit` for an authenticated invocation.
 * Returns `undefined` (i.e. inherit `process.env`) when askpass isn't
 * configured — useful in tests that mock spawn entirely.
 */
const authedEnv = (
  askpassPath: string | undefined,
  token: string,
): NodeJS.ProcessEnv | undefined =>
  askpassPath ? buildAskpassEnv({ askpassPath, password: token }) : undefined;

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/**
 * Stamp file path *relative to the clone root*. Lives inside `.git/` so
 * it never appears in `git status --porcelain` — otherwise the clean-tree
 * check used by `WorkspaceSCM.checkoutBranch` would always reject a
 * just-cloned workspace as "dirty".
 */
const LAST_FETCH_FILE = ".git/filework-last-fetch";
/** Pre-fix location at the working-tree root; removed on first encounter. */
const LEGACY_LAST_FETCH_FILE = ".last-fetch";

/** Run a git subprocess and capture stdout/stderr. Throws on non-zero exit. */
const runGit = async (
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; spawnFn?: typeof spawn } = {},
): Promise<{ stdout: string; stderr: string }> => {
  const sp = opts.spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = sp("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `git ${args[0]} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
  });
};

/**
 * One clone per `(owner, repo)` — branch is working-tree state, not a
 * path component. The `<repo>@<ref>` layout from earlier milestones is
 * cleaned up at app startup; see `migrate-clone-cache.ts`.
 */
const cloneDirFor = (cacheDir: string, ref: GitHubRef): string =>
  path.join(cacheDir, ref.owner, ref.repo);

const isFresh = async (cloneDir: string, ttlMs: number): Promise<boolean> => {
  try {
    const st = await stat(path.join(cloneDir, LAST_FETCH_FILE));
    return Date.now() - st.mtimeMs < ttlMs;
  } catch {
    return false;
  }
};

const stamp = async (cloneDir: string): Promise<void> => {
  await writeFile(
    path.join(cloneDir, LAST_FETCH_FILE),
    new Date().toISOString(),
    "utf8",
  );
};

const cloneExists = async (cloneDir: string): Promise<boolean> => {
  try {
    const st = await stat(path.join(cloneDir, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Materialize the clone for `ref` at `cloneDir`. One clone per repo —
 * `ref.ref` is the *initial branch* (used by `git clone -b`), not
 * part of the directory path.
 *
 *   - No clone yet → `git clone -b <ref.ref> --filter=blob:none`.
 *     Partial clone: all refs visible (no `--single-branch`), blobs
 *     fetched on demand. Working tree lands on `ref.ref`.
 *   - Clone exists + stale → `git fetch origin` (updates all
 *     remote-tracking refs; does *not* touch the working tree, so
 *     uncommitted agent work or non-default branches survive).
 *   - Clone exists + fresh → no-op.
 *
 * Branch switching after initial clone is an explicit user action —
 * see `WorkspaceSCM.checkoutBranch`. ensureClone never auto-switches.
 *
 * Concurrency: wrapped in `withCloneLock(cloneDir)` so concurrent
 * creators of the same workspace queue rather than racing on
 * filesystem state.
 *
 * Auth: the remote URL is sanitized (no token), and the token is
 * passed via GIT_ASKPASS env. Refresh paths re-write the remote URL
 * to scrub any pre-M7 token leak.
 */
export const ensureClone = async (
  ref: GitHubRef,
  deps: GitHubWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  return withCloneLock(cloneDir, async () => {
    const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
    const exists = await cloneExists(cloneDir);

    if (exists && (await isFresh(cloneDir, ttlMs))) {
      return cloneDir;
    }

    const token = await deps.resolveToken(ref.credentialId);
    const remote = githubSanitizedRemote(ref.owner, ref.repo);
    const env = await buildGitProxyEnv(
      authedEnv(deps.askpassPath, token) ?? process.env,
      remote,
      deps.resolveProxy,
    );

    if (!exists) {
      await mkdir(path.dirname(cloneDir), { recursive: true });
      try {
        await runGit(
          [
            "clone",
            "--filter=blob:none",
            "--branch",
            ref.ref,
            remote,
            cloneDir,
          ],
          { spawnFn: deps.spawnFn, env },
        );
      } catch (err) {
        await rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    } else {
      // Stale refresh: re-sanitize remote (covers pre-M7 clones whose
      // .git/config still has an embedded token), then fetch every
      // ref. No `reset --hard` — the working tree carries session
      // branches we must not clobber.
      await runGit(["remote", "set-url", "origin", remote], {
        cwd: cloneDir,
        spawnFn: deps.spawnFn,
      });
      await runGit(["fetch", "origin"], {
        cwd: cloneDir,
        spawnFn: deps.spawnFn,
        env,
      });
    }

    // Drop any legacy root-level stamp file from before it moved into
    // `.git/`. Otherwise `git status --porcelain` reports it as `??` and
    // every clone looks "dirty" to `checkoutBranch`.
    await rm(path.join(cloneDir, LEGACY_LAST_FETCH_FILE), { force: true });

    await stamp(cloneDir);
    return cloneDir;
  });
};

interface GitHubScmDeps {
  cloneDir: string;
  baseBranch: string;
  owner: string;
  repo: string;
  resolveToken: () => Promise<string>;
  sessionScope: string;
  /** GIT_ASKPASS helper path. Same plumbing as ensureClone. */
  askpassPath?: string;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  /** See `GitHubWorkspaceDeps.resolveProxy`. */
  resolveProxy?: ProxyResolver;
}

const GH_HEADERS = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

const COMMIT_AUTHOR = "Claude <claude@anthropic.com>";

class GitHubWorkspaceSCM implements WorkspaceSCM {
  constructor(private readonly deps: GitHubScmDeps) {}

  private get cwd(): string {
    return this.deps.cloneDir;
  }

  private sessionBranch(): string {
    return `claude/${this.deps.sessionScope}`;
  }

  async status(): Promise<{ branch: string; dirty: boolean }> {
    const { stdout } = await runGit(["status", "--porcelain"], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
    const branch = await this.currentBranch();
    return { branch, dirty: stdout.trim().length > 0 };
  }

  async diff(rel?: string): Promise<string> {
    const args = ["diff", "--no-color"];
    if (rel) args.push("--", rel);
    const { stdout } = await runGit(args, {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
    return stdout;
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
    return stdout.trim();
  }

  async checkoutBranch(input: {
    branch: string;
  }): Promise<{ branch: string; previousBranch: string }> {
    return withCloneLock(this.cwd, async () => {
      const previousBranch = await this.currentBranch();
      if (previousBranch === input.branch) {
        return { branch: input.branch, previousBranch };
      }
      const token = await this.deps.resolveToken();
      await runGit(
        [
          "remote",
          "set-url",
          "origin",
          githubSanitizedRemote(this.deps.owner, this.deps.repo),
        ],
        { cwd: this.cwd, spawnFn: this.deps.spawnFn },
      );
      await runGit(["fetch", "origin"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
        env: await buildGitProxyEnv(
          authedEnv(this.deps.askpassPath, token) ?? process.env,
          githubSanitizedRemote(this.deps.owner, this.deps.repo),
          this.deps.resolveProxy,
        ),
      });
      await checkoutBranchTo(this.cwd, input.branch, this.deps.spawnFn);
      return { branch: input.branch, previousBranch };
    });
  }

  async commit(input: {
    message: string;
    files?: string[];
  }): Promise<{ sha: string; branch: string; filesChanged: number }> {
    await this.ensureSessionBranch();
    if (input.files && input.files.length > 0) {
      await runGit(["add", "--", ...input.files], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      });
    } else {
      await runGit(["add", "-A"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      });
    }
    const staged = (
      await runGit(["diff", "--cached", "--name-only"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      })
    ).stdout.trim();
    if (!staged) {
      return { sha: "", branch: this.sessionBranch(), filesChanged: 0 };
    }
    await runGit(["commit", "-m", input.message, "--author", COMMIT_AUTHOR], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
    const sha = (
      await runGit(["rev-parse", "HEAD"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      })
    ).stdout.trim();
    return {
      sha,
      branch: this.sessionBranch(),
      filesChanged: staged.split("\n").filter(Boolean).length,
    };
  }

  async push(input?: {
    force?: boolean;
  }): Promise<{ branch: string; remote: string }> {
    const token = await this.deps.resolveToken();
    // Always sanitize the remote URL — covers pre-M7 clones whose
    // .git/config still holds an embedded token from before this PR.
    await runGit(
      [
        "remote",
        "set-url",
        "origin",
        githubSanitizedRemote(this.deps.owner, this.deps.repo),
      ],
      { cwd: this.cwd, spawnFn: this.deps.spawnFn },
    );
    const branch = this.sessionBranch();
    const args = ["push", "-u", "origin", branch];
    if (input?.force) args.push("--force-with-lease");
    await runGit(args, {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
      env: await buildGitProxyEnv(
        authedEnv(this.deps.askpassPath, token) ?? process.env,
        githubSanitizedRemote(this.deps.owner, this.deps.repo),
        this.deps.resolveProxy,
      ),
    });
    return { branch, remote: "origin" };
  }

  async openPullRequest(input: {
    title: string;
    body?: string;
    draft?: boolean;
    base?: string;
  }): Promise<{ url: string; number: number }> {
    // Precheck: head branch must exist on the remote, otherwise PR
    // creation fails with a confusing 422. Surface a friendlier error.
    const branch = this.sessionBranch();
    const lsRemote = await runGit(["ls-remote", "origin", branch], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
      env: await buildGitProxyEnv(
        process.env,
        githubSanitizedRemote(this.deps.owner, this.deps.repo),
        this.deps.resolveProxy,
      ),
    });
    if (!lsRemote.stdout.trim()) {
      throw new Error(
        `Branch "${branch}" has no commits pushed to origin. Call gitPush before openPullRequest.`,
      );
    }

    const json = await this.ghPost<{ number: number; html_url: string }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls`,
      {
        title: input.title,
        body: input.body ?? "",
        head: branch,
        base: input.base ?? this.deps.baseBranch,
        draft: input.draft ?? false,
      },
      "PR create",
    );
    return { url: json.html_url, number: json.number };
  }

  // ── M6 PR 3: query / comment surface ──────────────────────────────────

  async listPullRequests(
    input: {
      state?: "open" | "closed" | "all";
      base?: string;
      head?: string;
    } = {},
  ): Promise<PullRequestSummary[]> {
    const params = new URLSearchParams({ per_page: "100" });
    if (input.state) params.set("state", input.state);
    if (input.base) params.set("base", input.base);
    if (input.head) params.set("head", input.head);
    const rows = await this.ghJson<RawPR[]>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls?${params.toString()}`,
    );
    return rows.map(toPRSummary);
  }

  async getPullRequest(input: { number: number }): Promise<PullRequestDetail> {
    const raw = await this.ghJson<RawPRDetail>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/${input.number}`,
    );
    return toPRDetail(raw);
  }

  async listIssues(
    input: { state?: "open" | "closed" | "all"; labels?: string[] } = {},
  ): Promise<IssueSummary[]> {
    const params = new URLSearchParams({ per_page: "100" });
    if (input.state) params.set("state", input.state);
    if (input.labels && input.labels.length > 0) {
      params.set("labels", input.labels.join(","));
    }
    const rows = await this.ghJson<RawIssue[]>(
      `/repos/${this.deps.owner}/${this.deps.repo}/issues?${params.toString()}`,
    );
    // GitHub's /issues endpoint includes PRs by default; filter them out so
    // the model never has to.
    return rows.filter((r) => !r.pull_request).map(toIssueSummary);
  }

  async getIssue(input: { number: number }): Promise<IssueDetail> {
    const raw = await this.ghJson<RawIssueDetail>(
      `/repos/${this.deps.owner}/${this.deps.repo}/issues/${input.number}`,
    );
    return toIssueDetail(raw);
  }

  async commentIssue(input: {
    number: number;
    body: string;
  }): Promise<{ commentId: number; url: string }> {
    const raw = await this.ghPost<{ id: number; html_url: string }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/issues/${input.number}/comments`,
      { body: input.body },
      "issue comment",
    );
    return { commentId: raw.id, url: raw.html_url };
  }

  async commentPullRequest(input: {
    number: number;
    body: string;
  }): Promise<{ commentId: number; url: string }> {
    // GitHub treats PR conversation comments as issue comments; same endpoint.
    return this.commentIssue(input);
  }

  async searchCode(input: { query: string }): Promise<CodeSearchResult> {
    // Always pin to this repo so search results stay in-scope.
    const q = `${input.query} repo:${this.deps.owner}/${this.deps.repo}`;
    const url = `/search/code?q=${encodeURIComponent(q)}&per_page=100`;
    const raw = await this.ghJson<{
      total_count: number;
      items: RawSearchHit[];
    }>(url);
    return {
      totalCount: raw.total_count,
      items: raw.items.map((item) => ({
        name: item.name,
        path: item.path,
        repo: item.repository.full_name,
        htmlUrl: item.html_url,
      })),
    };
  }

  // ── M8: CI / pipeline status ─────────────────────────────────────────

  async listCIRuns(
    input: {
      ref?: string;
      status?: "all" | "in_progress" | "completed";
      limit?: number;
    } = {},
  ): Promise<CIRunSummary[]> {
    const params = new URLSearchParams({
      per_page: String(Math.min(input.limit ?? 100, 100)),
    });
    if (input.ref) params.set("branch", input.ref);
    if (input.status) params.set("status", input.status);
    const raw = await this.ghJson<{ workflow_runs: RawWorkflowRun[] }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/runs?${params.toString()}`,
    );
    return raw.workflow_runs.map(toCIRunSummaryFromGH);
  }

  async getCIRun(input: { id: string }): Promise<CIRunDetail> {
    const raw = await this.ghJson<RawWorkflowRunDetail>(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/runs/${input.id}`,
    );
    return toCIRunDetailFromGH(raw);
  }

  async listCIJobs(input: { runId: string }): Promise<CIJobSummary[]> {
    const raw = await this.ghJson<{ jobs: RawWorkflowJob[] }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/runs/${input.runId}/jobs?per_page=100`,
    );
    return raw.jobs.map(toCIJobSummaryFromGH);
  }

  // ── M9: CI logs + re-run ─────────────────────────────────────────────

  async getCIJobLog(input: {
    jobId: string;
    lastLines?: number;
  }): Promise<CIJobLog> {
    const raw = await this.ghText(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/jobs/${input.jobId}/logs`,
    );
    return projectLogTail(input.jobId, raw, input.lastLines ?? 500);
  }

  async rerunCI(input: {
    runId: string;
    failedOnly?: boolean;
  }): Promise<{ runId: string; queued: boolean }> {
    const failedOnly = input.failedOnly ?? true;
    const path = failedOnly ? "rerun-failed-jobs" : "rerun";
    // GitHub returns 201 with no body for /rerun*, so we skip JSON parsing.
    await this.ghPostNoBody(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/runs/${input.runId}/${path}`,
      `rerun (${failedOnly ? "failed" : "all"})`,
    );
    return { runId: input.runId, queued: true };
  }

  // ── M10: PR review + combined commit checks ──────────────────────────

  async reviewPullRequest(
    input: PullRequestReviewInput,
  ): Promise<PullRequestReviewResult> {
    const body: Record<string, unknown> = {
      comments: (input.comments ?? []).map((c) => {
        const entry: Record<string, unknown> = {
          path: c.path,
          line: c.line,
          body: c.body,
          side: "RIGHT",
        };
        // M15: multi-line range comment.
        if (c.startLine !== undefined) {
          entry.start_line = c.startLine;
          entry.start_side = "RIGHT";
        }
        return entry;
      }),
    };
    if (input.body !== undefined) body.body = input.body;
    if (input.event !== undefined) body.event = input.event;

    const res = await this.ghPost<{ id: number; html_url: string }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/${input.number}/reviews`,
      body,
      "PR review",
    );
    return { reviewId: String(res.id), url: res.html_url };
  }

  // ── M15: PR review lifecycle — dismiss + edit body ────────────────────

  async dismissPullRequestReview(input: {
    number: number;
    reviewId: string;
    message: string;
  }): Promise<{ reviewId: string; dismissed: boolean }> {
    await this.ghPut<{ id: number }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/${input.number}/reviews/${input.reviewId}/dismissals`,
      { message: input.message, event: "DISMISS" },
      "review dismiss",
    );
    return { reviewId: input.reviewId, dismissed: true };
  }

  async editPullRequestReviewBody(input: {
    number: number;
    reviewId: string;
    body: string;
  }): Promise<{ reviewId: string; url: string }> {
    const res = await this.ghPut<{ html_url: string }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/${input.number}/reviews/${input.reviewId}`,
      { body: input.body },
      "review edit body",
    );
    return { reviewId: input.reviewId, url: res.html_url };
  }

  // ── M17: PR inline-comment edit / delete ─────────────────────────────

  async listPullRequestReviewComments(input: {
    number: number;
  }): Promise<PullRequestReviewCommentSummary[]> {
    const raw = await this.ghJson<RawPullReviewComment[]>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/${input.number}/comments?per_page=100`,
    );
    return raw.map(toPullRequestReviewCommentSummary);
  }

  async editPullRequestReviewComment(input: {
    commentId: string;
    body: string;
  }): Promise<{ commentId: string; url: string }> {
    const res = await this.ghPatch<{ html_url: string }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/comments/${input.commentId}`,
      { body: input.body },
      "review-comment edit",
    );
    return { commentId: input.commentId, url: res.html_url };
  }

  async deletePullRequestReviewComment(input: {
    commentId: string;
  }): Promise<{ commentId: string; deleted: true }> {
    await this.ghDeleteNoBody(
      `/repos/${this.deps.owner}/${this.deps.repo}/pulls/comments/${input.commentId}`,
      "review-comment delete",
    );
    return { commentId: input.commentId, deleted: true };
  }

  async listCommitChecks(input: { sha: string }): Promise<CommitCheck[]> {
    const raw = await this.ghJson<{ check_runs: RawCheckRun[] }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/commits/${input.sha}/check-runs?per_page=100`,
    );
    return raw.check_runs.map(toCommitCheckFromGH);
  }

  // ── M11: CI write — cancel + workflow_dispatch ──────────────────────

  async cancelCI(input: {
    runId: string;
  }): Promise<{ runId: string; cancelled: boolean }> {
    await this.ghPostNoBody(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/runs/${input.runId}/cancel`,
      "cancel run",
    );
    return { runId: input.runId, cancelled: true };
  }

  async listWorkflows(): Promise<WorkflowSummary[]> {
    const raw = await this.ghJson<{ workflows: RawWorkflow[] }>(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/workflows?per_page=100`,
    );
    return raw.workflows.map(toWorkflowSummary);
  }

  async dispatchWorkflow(input: {
    workflowFile: string;
    ref: string;
    inputs?: Record<string, string>;
  }): Promise<{ workflowFile: string; ref: string; queued: boolean }> {
    // GitHub accepts either a workflow filename ("ci.yml") or numeric id
    // in the URL. We pass through whatever the agent provided.
    const id = encodeURIComponent(input.workflowFile);
    const body: Record<string, unknown> = { ref: input.ref };
    if (input.inputs !== undefined) body.inputs = input.inputs;
    await this.ghPostNoBody(
      `/repos/${this.deps.owner}/${this.deps.repo}/actions/workflows/${id}/dispatches`,
      "dispatch workflow",
      body,
    );
    return { workflowFile: input.workflowFile, ref: input.ref, queued: true };
  }

  // ── private fetch helpers (M6 PR 3) ───────────────────────────────────

  private async ghJson<T>(pathAndQuery: string): Promise<T> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, {
      headers: GH_HEADERS(token),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub ${res.status} for ${pathAndQuery}: ${text.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }

  private async ghPost<T>(
    pathAndQuery: string,
    body: unknown,
    label = "POST",
  ): Promise<T> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, {
      method: "POST",
      headers: GH_HEADERS(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${label} ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * PUT with JSON body — used by review-lifecycle endpoints (M15).
   * Mirror of ghPost but with method:"PUT". Both endpoints (dismiss +
   * edit-body) require a non-empty body, so no `ghPutNoBody` analog.
   */
  private async ghPut<T>(
    pathAndQuery: string,
    body: unknown,
    label = "PUT",
  ): Promise<T> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, {
      method: "PUT",
      headers: GH_HEADERS(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${label} ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * POST that doesn't expect a JSON response body. Used by:
   *   - `/actions/runs/.../rerun*` (201 + empty)   — body omitted
   *   - `/actions/runs/.../cancel`  (202 + empty)  — body omitted
   *   - `/actions/workflows/.../dispatches` (204 + empty) — body required
   *
   * When `body` is undefined we send no request body (NOT
   * `JSON.stringify(undefined)` which becomes the literal string
   * `"undefined"`). When provided, body is JSON-serialized.
   */
  private async ghPostNoBody(
    pathAndQuery: string,
    label = "POST",
    body?: unknown,
  ): Promise<void> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const init: RequestInit = {
      method: "POST",
      headers: GH_HEADERS(token),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${label} ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  /** PATCH with a JSON body — used by M17 review-comment edit. */
  private async ghPatch<T>(
    pathAndQuery: string,
    body: unknown,
    label = "PATCH",
  ): Promise<T> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, {
      method: "PATCH",
      headers: GH_HEADERS(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${label} ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** DELETE that returns 204 + empty body — used by M17 review-comment delete. */
  private async ghDeleteNoBody(
    pathAndQuery: string,
    label = "DELETE",
  ): Promise<void> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, {
      method: "DELETE",
      headers: GH_HEADERS(token),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${label} ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  /** GET that returns the raw text body — used by job log endpoints. */
  private async ghText(pathAndQuery: string): Promise<string> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`https://api.github.com${pathAndQuery}`, {
      headers: GH_HEADERS(token),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub ${res.status} for ${pathAndQuery}: ${text.slice(0, 200)}`,
      );
    }
    return res.text();
  }

  /**
   * Ensure the working tree is on `claude/<scope>`. First entry creates
   * the branch off the remote-tracking ref so the agent never commits
   * directly to the workspace's base ref.
   */
  private async ensureSessionBranch(): Promise<void> {
    const current = (
      await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.cwd,
        spawnFn: this.deps.spawnFn,
      })
    ).stdout.trim();
    const target = this.sessionBranch();
    if (current === target) return;
    await runGit(["checkout", "-B", target, `origin/${this.deps.baseBranch}`], {
      cwd: this.cwd,
      spawnFn: this.deps.spawnFn,
    });
  }
}

/**
 * Wraps the underlying LocalWorkspace exec to forbid `git push` etc. in
 * PR 1. The agent could otherwise reach the network through `runCommand`
 * even though the SCM surface throws. M6 PR 2 will replace this with a
 * proper write-approval flow.
 */
class GitHubWorkspaceExec implements WorkspaceExec {
  constructor(private readonly inner: WorkspaceExec) {}

  async run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (looksLikeGitWrite(command)) {
      return {
        stdout: "",
        stderr: `Refused: \`${command.split(/\s+/).slice(0, 3).join(" ")}\` — git write ops require M6 PR 2 approval flow.`,
        exitCode: 126,
      };
    }
    return this.inner.run(command, opts);
  }
}

const GIT_WRITE_VERBS = new Set([
  "push",
  "commit",
  "merge",
  "rebase",
  "reset",
  "tag",
  "am",
  "cherry-pick",
  "revert",
]);

/** Best-effort check: matches `git push`, `git -c x=y push --force`, etc. */
const looksLikeGitWrite = (command: string): boolean => {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git") return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    // `-c <key=val>` and `-C <path>` swallow the next token.
    if (t === "-c" || t === "-C") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return GIT_WRITE_VERBS.has(t);
  }
  return false;
};

/**
 * Stable per-ref fallback when no chat session id is available (e.g.
 * skills invoked outside a chat session). Same ref → same branch, so
 * repeated runs accumulate on a predictable target instead of churning.
 */
const fallbackSessionScope = (ref: GitHubRef): string => {
  const seed = `${ref.owner}/${ref.repo}@${ref.ref}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, "0").slice(0, 8);
};

export class GitHubWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "github";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm: WorkspaceSCM;

  private constructor(
    ref: GitHubRef,
    cloneDir: string,
    local: LocalWorkspace,
    deps: GitHubWorkspaceDeps,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = new GitHubWorkspaceExec(local.exec);
    this.scm = new GitHubWorkspaceSCM({
      cloneDir,
      baseBranch: ref.ref,
      owner: ref.owner,
      repo: ref.repo,
      resolveToken: () => deps.resolveToken(ref.credentialId),
      sessionScope: deps.sessionScope ?? fallbackSessionScope(ref),
      askpassPath: deps.askpassPath,
      spawnFn: deps.spawnFn,
      fetchFn: deps.fetchFn,
      resolveProxy: deps.resolveProxy,
    });
  }

  static async create(
    ref: GitHubRef,
    deps: GitHubWorkspaceDeps,
  ): Promise<GitHubWorkspace> {
    const cloneDir = await ensureClone(ref, deps);
    // Idempotent — first call per cloneDir installs the watcher;
    // subsequent calls are no-ops. Errors are swallowed inside.
    void startHeadWatcher(cloneDir);
    const local = new LocalWorkspace(cloneDir, { id: workspaceRefId(ref) });
    return new GitHubWorkspace(ref, cloneDir, local, deps);
  }
}

// ---------------------------------------------------------------------------
// Raw GitHub API shapes + projection helpers (M6 PR 3)
//
// `Raw*` types capture only the fields we actually project — the GitHub API
// surface is much larger but we deliberately don't model the rest so future
// API additions don't churn TypeScript.
// ---------------------------------------------------------------------------

interface RawUser {
  login: string;
}

interface RawLabel {
  name: string;
}

interface RawPR {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  draft: boolean;
  user: RawUser | null;
  head: { ref: string };
  base: { ref: string };
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawPRDetail extends RawPR {
  body: string | null;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
}

interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  user: RawUser | null;
  labels: Array<RawLabel | string>;
  /** Present iff the issue is actually a PR. We filter these out. */
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
}

interface RawIssueDetail extends RawIssue {
  body: string | null;
  closed_at: string | null;
}

interface RawSearchHit {
  name: string;
  path: string;
  html_url: string;
  repository: { full_name: string };
}

const labelName = (label: RawLabel | string): string =>
  typeof label === "string" ? label : label.name;

const toPRSummary = (raw: RawPR): PullRequestSummary => ({
  number: raw.number,
  title: raw.title,
  // GitHub returns "closed" + merged_at != null for merged PRs; surface
  // "merged" so the agent doesn't have to inspect two fields.
  state: raw.merged_at ? "merged" : raw.state,
  url: raw.html_url,
  head: raw.head.ref,
  base: raw.base.ref,
  user: raw.user?.login ?? "",
  draft: raw.draft,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

const toPRDetail = (raw: RawPRDetail): PullRequestDetail => ({
  ...toPRSummary(raw),
  body: raw.body ?? "",
  mergeable: raw.mergeable,
  additions: raw.additions,
  deletions: raw.deletions,
  mergedAt: raw.merged_at,
});

const toIssueSummary = (raw: RawIssue): IssueSummary => ({
  number: raw.number,
  title: raw.title,
  state: raw.state,
  url: raw.html_url,
  user: raw.user?.login ?? "",
  labels: raw.labels.map(labelName),
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

const toIssueDetail = (raw: RawIssueDetail): IssueDetail => ({
  ...toIssueSummary(raw),
  body: raw.body ?? "",
  closedAt: raw.closed_at,
});

// ── M8: CI / pipeline projections ─────────────────────────────────────

interface RawWorkflowRun {
  id: number;
  name: string | null;
  /** GitHub introduced this in 2022; older API responses fall back to `name`. */
  workflow_name?: string | null;
  status: CIRunStatus;
  conclusion: CIRunConclusion;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  run_started_at: string;
  updated_at: string;
}

interface RawWorkflowRunDetail extends RawWorkflowRun {
  event: string;
  /** Number of jobs; not always present, defaults to 0. */
  jobs?: { total_count?: number };
  /** Run-level totals from the per-run endpoint. */
  run_attempt?: number;
}

interface RawWorkflowJobStep {
  name: string;
  conclusion: CIRunConclusion;
}

interface RawWorkflowJob {
  id: number;
  name: string;
  status: CIRunStatus;
  conclusion: CIRunConclusion;
  html_url: string;
  started_at: string;
  completed_at: string | null;
  steps?: RawWorkflowJobStep[];
}

const toCIRunSummaryFromGH = (raw: RawWorkflowRun): CIRunSummary => ({
  id: String(raw.id),
  name: raw.name ?? raw.workflow_name ?? "",
  status: raw.status,
  conclusion: raw.conclusion,
  ref: raw.head_branch ?? "",
  commitSha: raw.head_sha,
  url: raw.html_url,
  startedAt: raw.run_started_at,
  completedAt: raw.status === "completed" ? raw.updated_at : null,
});

const toCIRunDetailFromGH = (raw: RawWorkflowRunDetail): CIRunDetail => {
  const summary = toCIRunSummaryFromGH(raw);
  const durationSec =
    summary.completedAt && summary.startedAt
      ? Math.max(
          0,
          Math.round(
            (Date.parse(summary.completedAt) - Date.parse(summary.startedAt)) /
              1000,
          ),
        )
      : null;
  return {
    ...summary,
    event: raw.event,
    durationSec,
    jobsCount: raw.jobs?.total_count ?? 0,
  };
};

/**
 * Slice the trailing `lastLines` lines off a raw log string and report
 * whether truncation happened. Shared by both providers (M9).
 *
 * `lastLines: 0` → unbounded, but still capped at MAX_LAST_LINES so a
 * runaway 100 MB log can't blow the agent's context budget.
 */
const MAX_LAST_LINES = 5000;

export const projectLogTail = (
  jobId: string,
  raw: string,
  lastLines: number,
): CIJobLog => {
  const lines = raw.split("\n");
  const totalLines = lines.length;
  const cap =
    lastLines === 0 ? MAX_LAST_LINES : Math.min(lastLines, MAX_LAST_LINES);
  const truncated = totalLines > cap;
  const slice = truncated ? lines.slice(totalLines - cap) : lines;
  return {
    jobId,
    content: slice.join("\n"),
    totalLines,
    truncated,
  };
};

interface RawCheckRun {
  name: string;
  status: CIRunStatus;
  conclusion: CIRunConclusion;
  html_url: string;
  /** App that created the check (omitted only on legacy responses). */
  app?: { slug?: string | null } | null;
}

interface RawWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

const toWorkflowSummary = (raw: RawWorkflow): WorkflowSummary => ({
  id: String(raw.id),
  name: raw.name,
  path: raw.path,
  state: raw.state,
});

const toCommitCheckFromGH = (raw: RawCheckRun): CommitCheck => ({
  name: raw.name,
  status: raw.status,
  conclusion: raw.conclusion,
  url: raw.html_url,
  source: raw.app?.slug ?? "unknown",
});

const toCIJobSummaryFromGH = (raw: RawWorkflowJob): CIJobSummary => ({
  id: String(raw.id),
  name: raw.name,
  status: raw.status,
  conclusion: raw.conclusion,
  url: raw.html_url,
  startedAt: raw.started_at,
  completedAt: raw.completed_at,
  failedSteps: (raw.steps ?? [])
    .filter((s) => s.conclusion === "failure")
    .map((s) => s.name),
});

// ── M17: PR review (inline) comment projection ──────────────────────

interface RawPullReviewComment {
  id: number;
  pull_request_review_id: number | null;
  user: { login: string } | null;
  path: string;
  line: number | null;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

const toPullRequestReviewCommentSummary = (
  raw: RawPullReviewComment,
): PullRequestReviewCommentSummary => ({
  id: String(raw.id),
  reviewId:
    raw.pull_request_review_id === null
      ? null
      : String(raw.pull_request_review_id),
  author: raw.user?.login ?? "(unknown)",
  path: raw.path,
  line: raw.line,
  body: raw.body,
  url: raw.html_url,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

export const __test__ = {
  looksLikeGitWrite,
  cloneDirFor,
  isFresh,
  stamp,
  fallbackSessionScope,
  toPRSummary,
  toPRDetail,
  toIssueSummary,
  toIssueDetail,
  toCIRunSummaryFromGH,
  toCIRunDetailFromGH,
  toCIJobSummaryFromGH,
  projectLogTail,
  toCommitCheckFromGH,
  toWorkflowSummary,
  toPullRequestReviewCommentSummary,
};
