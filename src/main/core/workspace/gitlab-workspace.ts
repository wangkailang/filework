/**
 * GitLabWorkspace — Workspace backed by an ephemeral local clone of a
 * GitLab project (gitlab.com or self-hosted).
 *
 * Mirrors `github-workspace.ts` line-for-line; key differences:
 *   - Authed clone URL uses `oauth2:<token>@<host>/<namespace>/<project>.git`
 *     (GitLab's recommended username for token auth).
 *   - REST API base is `https://${host}/api/v4`. All endpoints take an
 *     URL-encoded `<namespace>/<project>` as the project id.
 *   - "Pull request" maps to GitLab's "merge request"; SCM method names
 *     stay vendor-neutral (`openPullRequest` etc.) and project the GitLab
 *     `iid` to our `PullRequestSummary.number` so the agent's mental
 *     model is consistent across providers.
 *   - Issue endpoint returns issues only (GitLab doesn't mix MRs in like
 *     GitHub does), so no client-side filtering is needed.
 *   - Code search hits `/projects/:id/search?scope=blobs&search=<q>`,
 *     scoped to the workspace project.
 *
 * Token handling and clone freshness follow the same conventions as
 * `github-workspace.ts`. Raw `git push`-style runCommand calls are
 * refused via `looksLikeGitWrite` shared with the github exec wrapper.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildAskpassEnv, gitlabSanitizedRemote } from "./git-credentials";
import { projectLogTail } from "./github-workspace";
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
  PullRequestReviewInput,
  PullRequestReviewResult,
  PullRequestSummary,
  Workspace,
  WorkspaceExec,
  WorkspaceFS,
  WorkspaceKind,
  WorkspaceSCM,
} from "./types";
import { workspaceRefId } from "./workspace-ref";

export interface GitLabRef {
  kind: "gitlab";
  host: string;
  namespace: string;
  project: string;
  ref: string;
  credentialId: string;
}

export interface GitLabWorkspaceDeps {
  /** Returns a decrypted PAT for the credential id. Throws if missing. */
  resolveToken: (credentialId: string) => Promise<string>;
  /** Root for ephemeral clones, e.g. `~/.filework/cache/gitlab`. */
  cacheDir: string;
  /**
   * Absolute path to the GIT_ASKPASS helper script (M7). Production
   * wires this from `git-credentials.ts:ensureAskpassScript()`. See
   * `github-workspace.ts:GitHubWorkspaceDeps.askpassPath` for details.
   */
  askpassPath?: string;
  /** Default 1 hour. After this, GitLabWorkspace.create() refreshes. */
  freshnessTtlMs?: number;
  /** Override the spawn implementation in tests. */
  spawnFn?: typeof spawn;
  /** Override the fetch implementation in tests. */
  fetchFn?: typeof fetch;
  /** Per-session scope for auto-branching. */
  sessionScope?: string;
}

const authedEnv = (
  askpassPath: string | undefined,
  token: string,
): NodeJS.ProcessEnv | undefined =>
  askpassPath ? buildAskpassEnv({ askpassPath, password: token }) : undefined;

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const LAST_FETCH_FILE = ".last-fetch";

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
 * Clone dir layout: `<cacheDir>/<host>/<namespace>/<project>@<ref>/`.
 * The host is included so the same `<namespace>/<project>` on different
 * GitLab instances doesn't collide.
 */
const cloneDirFor = (cacheDir: string, ref: GitLabRef): string =>
  path.join(cacheDir, ref.host, ref.namespace, `${ref.project}@${ref.ref}`);

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
 * Materialize the clone for `ref`. M7: the remote URL is sanitized
 * (no token); the token is supplied via GIT_ASKPASS env. Refresh paths
 * always re-write the remote URL to scrub pre-M7 token leaks.
 */
export const ensureClone = async (
  ref: GitLabRef,
  deps: GitLabWorkspaceDeps,
): Promise<string> => {
  const cloneDir = cloneDirFor(deps.cacheDir, ref);
  const ttlMs = deps.freshnessTtlMs ?? DEFAULT_TTL_MS;
  const exists = await cloneExists(cloneDir);

  if (exists && (await isFresh(cloneDir, ttlMs))) {
    return cloneDir;
  }

  const token = await deps.resolveToken(ref.credentialId);
  const remote = gitlabSanitizedRemote(ref.host, ref.namespace, ref.project);
  const env = authedEnv(deps.askpassPath, token);

  if (!exists) {
    await mkdir(path.dirname(cloneDir), { recursive: true });
    try {
      await runGit(
        ["clone", "--depth", "1", "--branch", ref.ref, remote, cloneDir],
        { spawnFn: deps.spawnFn, env },
      );
    } catch (err) {
      await rm(cloneDir, { recursive: true, force: true });
      throw err;
    }
  } else {
    // Sanitize the remote URL on every refresh — covers pre-M7 clones.
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

interface GitLabScmDeps {
  cloneDir: string;
  baseBranch: string;
  host: string;
  namespace: string;
  project: string;
  resolveToken: () => Promise<string>;
  sessionScope: string;
  askpassPath?: string;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
}

const GL_HEADERS = (token: string): Record<string, string> => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const COMMIT_AUTHOR = "Claude <claude@anthropic.com>";

const projectIdEncoded = (d: GitLabScmDeps): string =>
  encodeURIComponent(`${d.namespace}/${d.project}`);

/** Map our state union to GitLab's MR `state` query value. */
const glStateOut = (s: "open" | "closed" | "all"): string =>
  s === "open" ? "opened" : s;

class GitLabWorkspaceSCM implements WorkspaceSCM {
  constructor(private readonly deps: GitLabScmDeps) {}

  private get cwd(): string {
    return this.deps.cloneDir;
  }

  private sessionBranch(): string {
    return `claude/${this.deps.sessionScope}`;
  }

  private apiBase(): string {
    return `https://${this.deps.host}/api/v4`;
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
    // Sanitize the remote URL — covers pre-M7 clones with embedded tokens.
    await runGit(
      [
        "remote",
        "set-url",
        "origin",
        gitlabSanitizedRemote(
          this.deps.host,
          this.deps.namespace,
          this.deps.project,
        ),
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

    const json = await this.glPost<{ iid: number; web_url: string }>(
      `/projects/${projectIdEncoded(this.deps)}/merge_requests`,
      {
        source_branch: branch,
        target_branch: input.base ?? this.deps.baseBranch,
        title: input.title,
        description: input.body ?? "",
        // `draft: true` is honored by GitLab 13.0+; older instances ignore it.
        draft: input.draft ?? false,
      },
      "MR create",
    );
    return { url: json.web_url, number: json.iid };
  }

  async listPullRequests(
    input: {
      state?: "open" | "closed" | "all";
      base?: string;
      head?: string;
    } = {},
  ): Promise<PullRequestSummary[]> {
    const params = new URLSearchParams({ per_page: "100" });
    if (input.state) params.set("state", glStateOut(input.state));
    if (input.base) params.set("target_branch", input.base);
    if (input.head) params.set("source_branch", input.head);
    const rows = await this.glJson<RawMR[]>(
      `/projects/${projectIdEncoded(this.deps)}/merge_requests?${params.toString()}`,
    );
    return rows.map(toPRSummaryFromMR);
  }

  async getPullRequest(input: { number: number }): Promise<PullRequestDetail> {
    const raw = await this.glJson<RawMRDetail>(
      `/projects/${projectIdEncoded(this.deps)}/merge_requests/${input.number}`,
    );
    return toPRDetailFromMR(raw);
  }

  async listIssues(
    input: { state?: "open" | "closed" | "all"; labels?: string[] } = {},
  ): Promise<IssueSummary[]> {
    const params = new URLSearchParams({ per_page: "100" });
    if (input.state) params.set("state", glStateOut(input.state));
    if (input.labels && input.labels.length > 0) {
      // GitLab's `labels` query is comma-separated, AND-matched.
      params.set("labels", input.labels.join(","));
    }
    const rows = await this.glJson<RawGlIssue[]>(
      `/projects/${projectIdEncoded(this.deps)}/issues?${params.toString()}`,
    );
    // Unlike GitHub, GitLab's /issues endpoint does NOT include MRs.
    return rows.map(toIssueSummaryFromGl);
  }

  async getIssue(input: { number: number }): Promise<IssueDetail> {
    const raw = await this.glJson<RawGlIssueDetail>(
      `/projects/${projectIdEncoded(this.deps)}/issues/${input.number}`,
    );
    return toIssueDetailFromGl(raw);
  }

  async commentIssue(input: {
    number: number;
    body: string;
  }): Promise<{ commentId: number; url: string }> {
    const raw = await this.glPost<RawGlNote>(
      `/projects/${projectIdEncoded(this.deps)}/issues/${input.number}/notes`,
      { body: input.body },
      "issue note",
    );
    return {
      commentId: raw.id,
      url: this.commentUrl("issues", input.number, raw.id),
    };
  }

  async commentPullRequest(input: {
    number: number;
    body: string;
  }): Promise<{ commentId: number; url: string }> {
    const raw = await this.glPost<RawGlNote>(
      `/projects/${projectIdEncoded(this.deps)}/merge_requests/${input.number}/notes`,
      { body: input.body },
      "MR note",
    );
    return {
      commentId: raw.id,
      url: this.commentUrl("merge_requests", input.number, raw.id),
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
    if (input.ref) params.set("ref", input.ref);
    // GitLab has no direct "completed" filter — `success` is the most common
    // completed state and matches the documented user contract. The GitHub
    // backend gets the full lifecycle filter; this is a deliberate trade.
    if (input.status === "in_progress") params.set("status", "running");
    if (input.status === "completed") params.set("status", "success");
    const rows = await this.glJson<RawGlPipeline[]>(
      `/projects/${projectIdEncoded(this.deps)}/pipelines?${params.toString()}`,
    );
    return rows.map(toCIRunSummaryFromGL);
  }

  async getCIRun(input: { id: string }): Promise<CIRunDetail> {
    const raw = await this.glJson<RawGlPipelineDetail>(
      `/projects/${projectIdEncoded(this.deps)}/pipelines/${encodeURIComponent(input.id)}`,
    );
    return toCIRunDetailFromGL(raw);
  }

  async listCIJobs(input: { runId: string }): Promise<CIJobSummary[]> {
    const rows = await this.glJson<RawGlJob[]>(
      `/projects/${projectIdEncoded(this.deps)}/pipelines/${encodeURIComponent(input.runId)}/jobs?per_page=100`,
    );
    return rows.map(toCIJobSummaryFromGL);
  }

  // ── M9: CI logs + re-run ─────────────────────────────────────────────

  async getCIJobLog(input: {
    jobId: string;
    lastLines?: number;
  }): Promise<CIJobLog> {
    const raw = await this.glText(
      `/projects/${projectIdEncoded(this.deps)}/jobs/${encodeURIComponent(input.jobId)}/trace`,
    );
    return projectLogTail(input.jobId, raw, input.lastLines ?? 500);
  }

  async rerunCI(input: {
    runId: string;
    failedOnly?: boolean;
  }): Promise<{ runId: string; queued: boolean }> {
    const failedOnly = input.failedOnly ?? true;
    if (!failedOnly) {
      throw new Error(
        "GitLab does not support full pipeline re-run via /retry — create a new pipeline on the same ref via the GitLab UI instead.",
      );
    }
    await this.glPost<unknown>(
      `/projects/${projectIdEncoded(this.deps)}/pipelines/${encodeURIComponent(input.runId)}/retry`,
      {},
      "pipeline retry",
    );
    return { runId: input.runId, queued: true };
  }

  // ── M10: PR review + combined commit checks ──────────────────────────

  async reviewPullRequest(
    input: PullRequestReviewInput,
  ): Promise<PullRequestReviewResult> {
    // GitLab anchors line comments by SHAs; fetch the MR detail first.
    const mr = await this.glJson<RawMRDetail>(
      `/projects/${projectIdEncoded(this.deps)}/merge_requests/${input.number}`,
    );
    const refs = mr.diff_refs;
    const comments = input.comments ?? [];

    let firstId: string | null = null;
    let firstUrl: string = mr.web_url;

    for (const c of comments) {
      if (!refs) {
        throw new Error(
          "GitLab MR has no diff_refs — cannot anchor inline comments",
        );
      }
      const d = await this.glPost<RawGlDiscussion>(
        `/projects/${projectIdEncoded(this.deps)}/merge_requests/${input.number}/discussions`,
        {
          body: c.body,
          position: {
            base_sha: refs.base_sha,
            head_sha: refs.head_sha,
            start_sha: refs.start_sha,
            position_type: "text",
            new_path: c.path,
            new_line: c.line,
          },
        },
        "MR discussion",
      );
      if (firstId === null) {
        firstId = d.id;
        firstUrl = this.discussionUrl(input.number, d.id);
      }
    }

    if (input.body) {
      const note = await this.glPost<RawGlNote>(
        `/projects/${projectIdEncoded(this.deps)}/merge_requests/${input.number}/notes`,
        { body: input.body },
        "MR review note",
      );
      if (firstId === null) {
        firstId = String(note.id);
        firstUrl = this.commentUrl("merge_requests", input.number, note.id);
      }
    }

    if (firstId === null) {
      throw new Error(
        "reviewMergeRequest needs at least one comment or a body",
      );
    }
    // input.event is intentionally ignored on GitLab — see tool description.
    return { reviewId: firstId, url: firstUrl };
  }

  async listCommitChecks(input: { sha: string }): Promise<CommitCheck[]> {
    const raw = await this.glJson<RawGlStatus[]>(
      `/projects/${projectIdEncoded(this.deps)}/repository/commits/${encodeURIComponent(input.sha)}/statuses?per_page=100`,
    );
    return raw.map(toCommitCheckFromGL);
  }

  async searchCode(input: { query: string }): Promise<CodeSearchResult> {
    // GitLab's project-scoped blob search.
    const url =
      `/projects/${projectIdEncoded(this.deps)}/search` +
      `?scope=blobs&per_page=100&search=${encodeURIComponent(input.query)}`;
    const raw = await this.glJson<RawGlSearchHit[]>(url);
    const fullPath = `${this.deps.namespace}/${this.deps.project}`;
    return {
      // GitLab's blob search doesn't return a total_count header here;
      // surface the page length to keep the shape consistent.
      totalCount: raw.length,
      items: raw.map((hit) => ({
        name: hit.basename ?? path.basename(hit.path),
        path: hit.path,
        repo: fullPath,
        htmlUrl: `https://${this.deps.host}/${fullPath}/-/blob/${encodeURIComponent(hit.ref ?? this.deps.baseBranch)}/${hit.path}`,
      })),
    };
  }

  // ── private helpers ─────────────────────────────────────────────────

  private commentUrl(
    kind: "issues" | "merge_requests",
    iid: number,
    noteId: number,
  ): string {
    return `https://${this.deps.host}/${this.deps.namespace}/${this.deps.project}/-/${kind}/${iid}#note_${noteId}`;
  }

  private discussionUrl(iid: number, discussionId: string): string {
    return `https://${this.deps.host}/${this.deps.namespace}/${this.deps.project}/-/merge_requests/${iid}#note_${discussionId}`;
  }

  private async glJson<T>(pathAndQuery: string): Promise<T> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`${this.apiBase()}${pathAndQuery}`, {
      headers: GL_HEADERS(token),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitLab ${res.status} for ${pathAndQuery}: ${text.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }

  private async glPost<T>(
    pathAndQuery: string,
    body: unknown,
    label = "POST",
  ): Promise<T> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`${this.apiBase()}${pathAndQuery}`, {
      method: "POST",
      headers: GL_HEADERS(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab ${label} ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** GET that returns the raw text body — used by job trace (M9). */
  private async glText(pathAndQuery: string): Promise<string> {
    const token = await this.deps.resolveToken();
    const fetchImpl = this.deps.fetchFn ?? fetch;
    const res = await fetchImpl(`${this.apiBase()}${pathAndQuery}`, {
      headers: GL_HEADERS(token),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitLab ${res.status} for ${pathAndQuery}: ${text.slice(0, 200)}`,
      );
    }
    return res.text();
  }

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

const looksLikeGitWrite = (command: string): boolean => {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git") return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t === "-c" || t === "-C") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return GIT_WRITE_VERBS.has(t);
  }
  return false;
};

class GitLabWorkspaceExec implements WorkspaceExec {
  constructor(private readonly inner: WorkspaceExec) {}

  async run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (looksLikeGitWrite(command)) {
      return {
        stdout: "",
        stderr: `Refused: \`${command.split(/\s+/).slice(0, 3).join(" ")}\` — use the typed gitCommit / gitPush / openPullRequest tools.`,
        exitCode: 126,
      };
    }
    return this.inner.run(command, opts);
  }
}

const fallbackSessionScope = (ref: GitLabRef): string => {
  const seed = `${ref.host}:${ref.namespace}/${ref.project}@${ref.ref}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, "0").slice(0, 8);
};

export class GitLabWorkspace implements Workspace {
  readonly kind: WorkspaceKind = "gitlab";
  readonly id: string;
  readonly root: string;
  readonly fs: WorkspaceFS;
  readonly exec: WorkspaceExec;
  readonly scm: WorkspaceSCM;

  private constructor(
    ref: GitLabRef,
    cloneDir: string,
    local: LocalWorkspace,
    deps: GitLabWorkspaceDeps,
  ) {
    this.id = workspaceRefId(ref);
    this.root = cloneDir;
    this.fs = local.fs;
    this.exec = new GitLabWorkspaceExec(local.exec);
    this.scm = new GitLabWorkspaceSCM({
      cloneDir,
      baseBranch: ref.ref,
      host: ref.host,
      namespace: ref.namespace,
      project: ref.project,
      resolveToken: () => deps.resolveToken(ref.credentialId),
      sessionScope: deps.sessionScope ?? fallbackSessionScope(ref),
      askpassPath: deps.askpassPath,
      spawnFn: deps.spawnFn,
      fetchFn: deps.fetchFn,
    });
  }

  static async create(
    ref: GitLabRef,
    deps: GitLabWorkspaceDeps,
  ): Promise<GitLabWorkspace> {
    const cloneDir = await ensureClone(ref, deps);
    const local = new LocalWorkspace(cloneDir, { id: workspaceRefId(ref) });
    return new GitLabWorkspace(ref, cloneDir, local, deps);
  }
}

// ---------------------------------------------------------------------------
// Raw GitLab API shapes + projection helpers
// ---------------------------------------------------------------------------

interface RawAuthor {
  username: string;
}

interface RawMR {
  iid: number;
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author: RawAuthor | null;
  source_branch: string;
  target_branch: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawMRDetail extends RawMR {
  description: string | null;
  has_conflicts?: boolean;
  changes_count?: string | number;
  diff_stats?: { additions: number; deletions: number };
  upvotes?: number;
  downvotes?: number;
  /**
   * SHAs needed to anchor positional review discussions (M10).
   * Present on all standard GitLab MR detail responses; missing only on
   * exotic states (e.g. squashed-and-merged historical MRs).
   */
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

interface RawGlIssue {
  iid: number;
  title: string;
  state: "opened" | "closed";
  web_url: string;
  author: RawAuthor | null;
  labels: string[];
  created_at: string;
  updated_at: string;
}

interface RawGlIssueDetail extends RawGlIssue {
  description: string | null;
  closed_at: string | null;
}

interface RawGlNote {
  id: number;
}

interface RawGlSearchHit {
  basename?: string;
  path: string;
  ref?: string;
}

const mapMrState = (
  s: RawMR["state"],
  mergedAt: string | null,
): "open" | "closed" | "merged" => {
  if (mergedAt || s === "merged") return "merged";
  if (s === "opened") return "open";
  // "closed" and "locked" → closed (locked is a moderation flag).
  return "closed";
};

const toPRSummaryFromMR = (raw: RawMR): PullRequestSummary => ({
  number: raw.iid,
  title: raw.title,
  state: mapMrState(raw.state, raw.merged_at),
  url: raw.web_url,
  head: raw.source_branch,
  base: raw.target_branch,
  user: raw.author?.username ?? "",
  draft: raw.draft ?? raw.work_in_progress ?? false,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

const toPRDetailFromMR = (raw: RawMRDetail): PullRequestDetail => ({
  ...toPRSummaryFromMR(raw),
  body: raw.description ?? "",
  // GitLab's MR detail returns `has_conflicts` (boolean) — invert for "mergeable".
  mergeable: typeof raw.has_conflicts === "boolean" ? !raw.has_conflicts : null,
  additions: raw.diff_stats?.additions ?? 0,
  deletions: raw.diff_stats?.deletions ?? 0,
  mergedAt: raw.merged_at,
});

const toIssueSummaryFromGl = (raw: RawGlIssue): IssueSummary => ({
  number: raw.iid,
  title: raw.title,
  state: raw.state === "opened" ? "open" : "closed",
  url: raw.web_url,
  user: raw.author?.username ?? "",
  labels: raw.labels,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

const toIssueDetailFromGl = (raw: RawGlIssueDetail): IssueDetail => ({
  ...toIssueSummaryFromGl(raw),
  body: raw.description ?? "",
  closedAt: raw.closed_at,
});

// ── M8: CI / pipeline projections ─────────────────────────────────────

interface RawGlPipeline {
  id: number;
  /** Optional human name; falls back to "pipeline #<id>". */
  name?: string | null;
  /** GitLab pipeline lifecycle. */
  status:
    | "created"
    | "pending"
    | "running"
    | "success"
    | "failed"
    | "canceled"
    | "skipped"
    | "manual"
    | "scheduled"
    | "preparing";
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

interface RawGlPipelineDetail extends RawGlPipeline {
  /** Trigger, e.g. "push", "merge_request_event", "schedule". */
  source?: string;
  duration?: number | null;
}

interface RawGlJob {
  id: number;
  name: string;
  status: RawGlPipeline["status"];
  web_url: string;
  started_at: string | null;
  finished_at: string | null;
}

interface RawGlDiscussion {
  /** GitLab discussion ids are SHA-like strings, not numbers. */
  id: string;
}

interface RawGlStatus {
  name: string;
  status: RawGlPipeline["status"];
  /** GitLab uses `target_url` for the per-status link. */
  target_url: string | null;
}

const toCommitCheckFromGL = (raw: RawGlStatus): CommitCheck => {
  const mapped = mapPipelineStatus(raw.status);
  return {
    name: raw.name,
    status: mapped.status,
    conclusion: mapped.conclusion,
    url: raw.target_url ?? "",
    source: "gitlab_ci",
  };
};

const mapPipelineStatus = (
  s: RawGlPipeline["status"],
): { status: CIRunStatus; conclusion: CIRunConclusion } => {
  switch (s) {
    case "created":
    case "pending":
    case "scheduled":
    case "preparing":
      return { status: "queued", conclusion: null };
    case "running":
      return { status: "in_progress", conclusion: null };
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failed":
      return { status: "completed", conclusion: "failure" };
    case "canceled":
      return { status: "completed", conclusion: "cancelled" };
    case "skipped":
      return { status: "completed", conclusion: "skipped" };
    case "manual":
      return { status: "completed", conclusion: "action_required" };
  }
};

const isCompletedStatus = (s: RawGlPipeline["status"]): boolean =>
  s === "success" ||
  s === "failed" ||
  s === "canceled" ||
  s === "skipped" ||
  s === "manual";

const toCIRunSummaryFromGL = (raw: RawGlPipeline): CIRunSummary => {
  const mapped = mapPipelineStatus(raw.status);
  return {
    id: String(raw.id),
    name: raw.name ?? `pipeline #${raw.id}`,
    status: mapped.status,
    conclusion: mapped.conclusion,
    ref: raw.ref,
    commitSha: raw.sha,
    url: raw.web_url,
    startedAt: raw.created_at,
    completedAt: isCompletedStatus(raw.status) ? raw.updated_at : null,
  };
};

const toCIRunDetailFromGL = (raw: RawGlPipelineDetail): CIRunDetail => ({
  ...toCIRunSummaryFromGL(raw),
  event: raw.source ?? "",
  durationSec: raw.duration ?? null,
  // `/pipelines/:id` doesn't include a job count; per-run jobs endpoint covers it.
  jobsCount: 0,
});

const toCIJobSummaryFromGL = (raw: RawGlJob): CIJobSummary => {
  const mapped = mapPipelineStatus(raw.status);
  return {
    id: String(raw.id),
    name: raw.name,
    status: mapped.status,
    conclusion: mapped.conclusion,
    url: raw.web_url,
    startedAt: raw.started_at ?? "",
    completedAt: raw.finished_at,
    // GitLab's job-list endpoint doesn't expose step status; full traces would
    // require log fetching, deferred. Always empty here.
    failedSteps: [],
  };
};

export const __test__ = {
  cloneDirFor,
  isFresh,
  stamp,
  fallbackSessionScope,
  looksLikeGitWrite,
  projectIdEncoded,
  glStateOut,
  mapMrState,
  toPRSummaryFromMR,
  toPRDetailFromMR,
  toIssueSummaryFromGl,
  toIssueDetailFromGl,
  mapPipelineStatus,
  toCIRunSummaryFromGL,
  toCIRunDetailFromGL,
  toCIJobSummaryFromGL,
  toCommitCheckFromGL,
};
