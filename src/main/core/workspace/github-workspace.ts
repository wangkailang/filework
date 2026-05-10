/**
 * GitHubWorkspace — Workspace backed by an ephemeral local clone of a
 * GitHub repository.
 *
 * Layout: `<cacheDir>/<owner>/<repo>@<ref>/` holds a shallow clone of
 * `https://github.com/<owner>/<repo>` checked out at `<ref>`. A sibling
 * `.last-fetch` file timestamps the most recent `git fetch` so freshness
 * checks don't re-walk the working tree.
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

import { buildAskpassEnv, githubSanitizedRemote } from "./git-credentials";
import { LocalWorkspace } from "./local-workspace";
import type {
  CIJobSummary,
  CIRunConclusion,
  CIRunDetail,
  CIRunStatus,
  CIRunSummary,
  CodeSearchResult,
  ExecOptions,
  ExecResult,
  IssueDetail,
  IssueSummary,
  PullRequestDetail,
  PullRequestSummary,
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
const LAST_FETCH_FILE = ".last-fetch";

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

const cloneDirFor = (cacheDir: string, ref: GitHubRef): string =>
  path.join(cacheDir, ref.owner, `${ref.repo}@${ref.ref}`);

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
 * Materialize the clone for `ref` at `cloneDir`. If the clone is
 * absent, perform a shallow clone. If present and stale, fetch + reset.
 * Returns the local clone directory once the working tree matches `ref.ref`.
 *
 * Auth: the remote URL is sanitized (no token), and the token is passed
 * to git via GIT_ASKPASS env. This means `.git/config` never holds the
 * PAT in plaintext. Refresh paths always re-write the remote URL to
 * the sanitized form, so pre-M7 clones get scrubbed automatically.
 */
export const ensureClone = async (
  ref: GitHubRef,
  deps: GitHubWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
  const exists = await cloneExists(cloneDir);

  if (exists && (await isFresh(cloneDir, ttlMs))) {
    return cloneDir;
  }

  const token = await deps.resolveToken(ref.credentialId);
  const remote = githubSanitizedRemote(ref.owner, ref.repo);
  const env = authedEnv(deps.askpassPath, token);

  if (!exists) {
    await mkdir(path.dirname(cloneDir), { recursive: true });
    try {
      await runGit(
        ["clone", "--depth", "1", "--branch", ref.ref, remote, cloneDir],
        { spawnFn: deps.spawnFn, env },
      );
    } catch (err) {
      // Failed clone — clean up partial dir to avoid wedging future attempts.
      await rm(cloneDir, { recursive: true, force: true });
      throw err;
    }
  } else {
    // Refresh: rewrite remote to sanitized form (scrubs any pre-M7
    // token-embedded URL), then fetch + hard-reset under askpass env.
    await runGit(["remote", "set-url", "origin", remote], {
      cwd: cloneDir,
      spawnFn: deps.spawnFn,
    });
    await runGit(["fetch", "--depth", "1", "origin", ref.ref], {
      cwd: cloneDir,
      spawnFn: deps.spawnFn,
      env,
    });
    await runGit(["reset", "--hard", "FETCH_HEAD"], {
      cwd: cloneDir,
      spawnFn: deps.spawnFn,
    });
  }

  await stamp(cloneDir);
  return cloneDir;
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
      env: authedEnv(this.deps.askpassPath, token),
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
    });
  }

  static async create(
    ref: GitHubRef,
    deps: GitHubWorkspaceDeps,
  ): Promise<GitHubWorkspace> {
    const cloneDir = await ensureClone(ref, deps);
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
};
