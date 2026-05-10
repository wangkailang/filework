import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type GitHubRef, GitHubWorkspace } from "../github-workspace";

/**
 * Build a fake `spawn` that records every git invocation and replays
 * canned stdout per subcommand. Each entry returns 0 by default; pass
 * `responses` to override stdout/code per call (array → consumed
 * sequentially across repeated calls of the same subcommand).
 */
const buildFakeSpawn = (
  responses: Record<
    string,
    { stdout?: string; code?: number } | { stdout?: string; code?: number }[]
  > = {},
) => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const cursors = new Map<string, number>();
  const fake = vi.fn(
    (
      _cmd: string,
      args: string[],
      opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, cwd: opts?.cwd });
      const sub = args[0] ?? "";
      const raw = responses[sub];
      let resp: { stdout?: string; code?: number } = { stdout: "", code: 0 };
      if (Array.isArray(raw)) {
        const idx = cursors.get(sub) ?? 0;
        cursors.set(sub, idx + 1);
        resp = raw[Math.min(idx, raw.length - 1)];
      } else if (raw) {
        resp = raw;
      }
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      if (args[0] === "clone") {
        const cloneDir = args[args.length - 1];
        mkdir(path.join(cloneDir, ".git"), { recursive: true }).then(() => {
          if (resp.stdout) proc.stdout.emit("data", Buffer.from(resp.stdout));
          setImmediate(() => proc.emit("close", resp.code ?? 0));
        });
      } else {
        setImmediate(() => {
          if (resp.stdout) proc.stdout.emit("data", Buffer.from(resp.stdout));
          proc.emit("close", resp.code ?? 0);
        });
      }
      return proc;
    },
  );
  return { fake, calls };
};

const fakeRef: GitHubRef = {
  kind: "github",
  owner: "acme",
  repo: "app",
  ref: "main",
  credentialId: "cred-1",
};

const buildWorkspace = async (
  cacheDir: string,
  fakeSpawn: ReturnType<typeof buildFakeSpawn>["fake"],
  fetchFn?: typeof fetch,
  sessionScope = "abcd1234",
): Promise<GitHubWorkspace> => {
  const cloneDir = path.join(cacheDir, "acme", "app@main");
  await mkdir(path.join(cloneDir, ".git"), { recursive: true });
  await writeFile(
    path.join(cloneDir, ".last-fetch"),
    new Date().toISOString(),
    "utf8",
  );
  return GitHubWorkspace.create(fakeRef, {
    resolveToken: async () => "ghp_TESTTOKEN",
    cacheDir,
    freshnessTtlMs: 60_000,
    // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
    spawnFn: fakeSpawn as any,
    fetchFn,
    sessionScope,
  });
};

describe("GitHubWorkspaceSCM.commit", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("auto-creates the session branch, stages all, commits, and returns the new sha", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": [
        { stdout: "main" }, // ensureSessionBranch: current
        { stdout: "abc1234deadbeef" }, // commit: HEAD sha
      ],
      diff: { stdout: "src/a.ts\nsrc/b.ts" }, // staged
    });
    const ws = await buildWorkspace(cacheDir, fake);

    if (!ws.scm.commit) throw new Error("commit not implemented");
    const result = await ws.scm.commit({ message: "fix: thing" });

    expect(result.sha).toBe("abc1234deadbeef");
    expect(result.branch).toBe("claude/abcd1234");
    expect(result.filesChanged).toBe(2);

    const subs = calls.map((c) => c.args[0]);
    expect(subs).toContain("checkout");
    expect(subs).toContain("add");
    expect(subs).toContain("commit");

    const checkoutCall = calls.find((c) => c.args[0] === "checkout");
    expect(checkoutCall?.args).toEqual([
      "checkout",
      "-B",
      "claude/abcd1234",
      "origin/main",
    ]);

    const commitCall = calls.find((c) => c.args[0] === "commit");
    expect(commitCall?.args).toEqual([
      "commit",
      "-m",
      "fix: thing",
      "--author",
      "Claude <claude@anthropic.com>",
    ]);
  });

  it("stages only specified files when `files` is provided", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": [{ stdout: "claude/abcd1234" }, { stdout: "deadbeef" }],
      diff: { stdout: "only-this.ts" },
    });
    const ws = await buildWorkspace(cacheDir, fake);
    await ws.scm.commit?.({ message: "x", files: ["only-this.ts"] });
    const addCall = calls.find((c) => c.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "--", "only-this.ts"]);
  });

  it("skips the session-branch checkout when already on it", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": [{ stdout: "claude/abcd1234" }, { stdout: "abc" }],
      diff: { stdout: "x.ts" },
    });
    const ws = await buildWorkspace(cacheDir, fake);
    await ws.scm.commit?.({ message: "x" });
    expect(calls.some((c) => c.args[0] === "checkout")).toBe(false);
  });

  it("returns sha:'' on a clean tree (no error)", async () => {
    const { fake } = buildFakeSpawn({
      "rev-parse": [{ stdout: "claude/abcd1234" }],
      diff: { stdout: "" },
    });
    const ws = await buildWorkspace(cacheDir, fake);
    const result = await ws.scm.commit?.({ message: "noop" });
    expect(result?.sha).toBe("");
    expect(result?.filesChanged).toBe(0);
  });
});

describe("GitHubWorkspaceSCM.push", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("sanitizes remote URL (no token) and pushes -u origin <branch> via askpass", async () => {
    const { fake, calls } = buildFakeSpawn();
    const ws = await buildWorkspace(cacheDir, fake);

    const result = await ws.scm.push?.({});

    expect(result).toEqual({ branch: "claude/abcd1234", remote: "origin" });
    const remoteCall = calls.find((c) => c.args[0] === "remote");
    expect(remoteCall?.args[0]).toBe("remote");
    expect(remoteCall?.args[1]).toBe("set-url");
    // M7: no token in the URL — username only.
    expect(remoteCall?.args[3]).toBe(
      "https://x-access-token@github.com/acme/app.git",
    );
    expect(remoteCall?.args[3]).not.toContain("ghp_TESTTOKEN");
    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args).toEqual(["push", "-u", "origin", "claude/abcd1234"]);
  });

  it("appends --force-with-lease when force=true", async () => {
    const { fake, calls } = buildFakeSpawn();
    const ws = await buildWorkspace(cacheDir, fake);
    await ws.scm.push?.({ force: true });
    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args).toContain("--force-with-lease");
  });
});

describe("GitHubWorkspaceSCM.openPullRequest", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /repos/<owner>/<repo>/pulls with the right body", async () => {
    const { fake } = buildFakeSpawn({
      "ls-remote": { stdout: "abc1234\trefs/heads/claude/abcd1234" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ number: 42, html_url: "https://gh/pr/42" }),
          { status: 201 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);

    const result = await ws.scm.openPullRequest?.({
      title: "Fix bug",
      body: "Detail",
      draft: true,
    });

    expect(result).toEqual({ url: "https://gh/pr/42", number: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/pulls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_TESTTOKEN",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          title: "Fix bug",
          body: "Detail",
          head: "claude/abcd1234",
          base: "main",
          draft: true,
        }),
      }),
    );
  });

  it("throws a friendly error when the head branch was never pushed", async () => {
    const { fake } = buildFakeSpawn({
      "ls-remote": { stdout: "" },
    });
    const fetchMock = vi.fn();
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);

    await expect(ws.scm.openPullRequest?.({ title: "x" })).rejects.toThrow(
      /no commits pushed.*gitPush/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates GitHub error responses", async () => {
    const { fake } = buildFakeSpawn({
      "ls-remote": { stdout: "abc1234\trefs/heads/claude/abcd1234" },
    });
    const fetchMock = vi.fn(
      async () => new Response("validation failed", { status: 422 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.openPullRequest?.({ title: "dup" })).rejects.toThrow(
      /422/,
    );
  });

  it("uses the user-supplied base when provided", async () => {
    const { fake } = buildFakeSpawn({
      "ls-remote": { stdout: "abc\trefs/heads/claude/abcd1234" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ number: 1, html_url: "u" }), {
          status: 201,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.openPullRequest?.({ title: "x", base: "develop" });
    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(callArgs[1].body));
    expect(body.base).toBe("develop");
  });
});

// ---------------------------------------------------------------------------
// M6 PR 3 — query / comment surface
// ---------------------------------------------------------------------------

const rawPR = (
  overrides: Partial<{
    number: number;
    state: "open" | "closed";
    merged_at: string | null;
    draft: boolean;
  }> = {},
) => ({
  number: overrides.number ?? 1,
  title: "Fix bug",
  state: overrides.state ?? "open",
  html_url: "https://gh/pr/1",
  draft: overrides.draft ?? false,
  user: { login: "octocat" },
  head: { ref: "feature" },
  base: { ref: "main" },
  merged_at: overrides.merged_at ?? null,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-02T00:00:00Z",
});

const rawIssue = (overrides: Partial<{ pull_request: unknown }> = {}) => ({
  number: 7,
  title: "Bug report",
  state: "open" as const,
  html_url: "https://gh/issues/7",
  user: { login: "alice" },
  labels: [{ name: "bug" }, "needs-triage"],
  pull_request: overrides.pull_request,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-02T00:00:00Z",
});

describe("GitHubWorkspaceSCM.listPullRequests", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("calls /repos/<o>/<r>/pulls with per_page=100 + filters", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([rawPR({ number: 1 })]), { status: 200 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.listPullRequests?.({ state: "all", base: "main" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/pulls");
    expect(url).toContain("per_page=100");
    expect(url).toContain("state=all");
    expect(url).toContain("base=main");
  });

  it("derives state='merged' when merged_at != null", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            rawPR({
              number: 1,
              state: "closed",
              merged_at: "2026-05-03T00:00:00Z",
            }),
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.listPullRequests?.();
    expect(result?.[0].state).toBe("merged");
  });
});

describe("GitHubWorkspaceSCM.getPullRequest", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("calls /repos/<o>/<r>/pulls/<number> and projects detail fields", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...rawPR({ number: 42 }),
            body: "PR body",
            mergeable: true,
            additions: 10,
            deletions: 3,
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.getPullRequest?.({ number: 42 });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe("https://api.github.com/repos/acme/app/pulls/42");
    expect(result).toMatchObject({
      number: 42,
      body: "PR body",
      mergeable: true,
      additions: 10,
      deletions: 3,
      mergedAt: null,
    });
  });
});

describe("GitHubWorkspaceSCM.listIssues", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("filters out PRs (rows where pull_request is set)", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            rawIssue(),
            rawIssue({ pull_request: { url: "..." } }),
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.listIssues?.();
    expect(result?.length).toBe(1);
    expect(result?.[0].number).toBe(7);
    expect(result?.[0].labels).toEqual(["bug", "needs-triage"]);
  });

  it("encodes labels as comma-joined query param", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify([]), { status: 200 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.listIssues?.({ labels: ["bug", "good first issue"] });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    // URLSearchParams encodes ',' literally and spaces as '+'. Parse the
    // query string back to verify the labels value structurally.
    const labels = new URL(url).searchParams.get("labels");
    expect(labels).toBe("bug,good first issue");
  });
});

describe("GitHubWorkspaceSCM.commentIssue / commentPullRequest", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /issues/<n>/comments and returns commentId+url", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 1234, html_url: "https://gh/comment/1234" }),
          { status: 201 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.commentIssue?.({ number: 7, body: "thanks!" });
    expect(result).toEqual({
      commentId: 1234,
      url: "https://gh/comment/1234",
    });
    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(
      "https://api.github.com/repos/acme/app/issues/7/comments",
    );
    expect(callArgs[1].method).toBe("POST");
    expect(JSON.parse(String(callArgs[1].body))).toEqual({ body: "thanks!" });
  });

  it("commentPullRequest aliases to the issue endpoint", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 99, html_url: "u" }), {
          status: 201,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.commentPullRequest?.({ number: 42, body: "looks good" });
    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(
      "https://api.github.com/repos/acme/app/issues/42/comments",
    );
  });
});

describe("GitHubWorkspaceSCM.searchCode", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-scm-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("appends repo:owner/name and projects results", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            items: [
              {
                name: "useChatSession.ts",
                path: "src/renderer/components/chat/useChatSession.ts",
                html_url: "https://gh/blob/...",
                repository: { full_name: "acme/app" },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.searchCode?.({ query: "useChatSession" });
    expect(result?.totalCount).toBe(1);
    expect(result?.items[0]).toEqual({
      name: "useChatSession.ts",
      path: "src/renderer/components/chat/useChatSession.ts",
      repo: "acme/app",
      htmlUrl: "https://gh/blob/...",
    });
    const callArgs = fetchMock.mock.calls[0] as unknown as [string];
    const url = decodeURIComponent(callArgs[0]);
    expect(url).toContain("/search/code?q=useChatSession repo:acme/app");
    expect(url).toContain("per_page=100");
  });
});
