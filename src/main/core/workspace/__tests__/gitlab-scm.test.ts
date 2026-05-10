import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type GitLabRef, GitLabWorkspace } from "../gitlab-workspace";

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

const fakeRef: GitLabRef = {
  kind: "gitlab",
  host: "gitlab.example.com",
  namespace: "acme/sub",
  project: "app",
  ref: "main",
  credentialId: "cred-1",
};

const buildWorkspace = async (
  cacheDir: string,
  fakeSpawn: ReturnType<typeof buildFakeSpawn>["fake"],
  fetchFn?: typeof fetch,
  sessionScope = "abcd1234",
): Promise<GitLabWorkspace> => {
  const cloneDir = path.join(
    cacheDir,
    "gitlab.example.com",
    "acme/sub",
    "app@main",
  );
  await mkdir(path.join(cloneDir, ".git"), { recursive: true });
  await writeFile(
    path.join(cloneDir, ".last-fetch"),
    new Date().toISOString(),
    "utf8",
  );
  return GitLabWorkspace.create(fakeRef, {
    resolveToken: async () => "glpat-TESTTOKEN",
    cacheDir,
    freshnessTtlMs: 60_000,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    spawnFn: fakeSpawn as any,
    fetchFn,
    sessionScope,
  });
};

const PROJECT_PATH = "acme%2Fsub%2Fapp";
const API_BASE = "https://gitlab.example.com/api/v4";

describe("GitLabWorkspaceSCM.commit", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("auto-creates the session branch and commits with Claude author", async () => {
    const { fake, calls } = buildFakeSpawn({
      "rev-parse": [{ stdout: "main" }, { stdout: "abc1234" }],
      diff: { stdout: "src/a.ts" },
    });
    const ws = await buildWorkspace(cacheDir, fake);
    const result = await ws.scm.commit?.({ message: "feat: x" });

    expect(result).toEqual({
      sha: "abc1234",
      branch: "claude/abcd1234",
      filesChanged: 1,
    });
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
      "feat: x",
      "--author",
      "Claude <claude@anthropic.com>",
    ]);
  });
});

describe("GitLabWorkspaceSCM.push", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
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
    // M7: no token in the URL.
    expect(remoteCall?.args[3]).toBe(
      "https://oauth2@gitlab.example.com/acme/sub/app.git",
    );
    expect(remoteCall?.args[3]).not.toContain("glpat-TESTTOKEN");
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

describe("GitLabWorkspaceSCM.openPullRequest (creates MR)", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /projects/:id/merge_requests with source_branch+target_branch", async () => {
    const { fake } = buildFakeSpawn({
      "ls-remote": { stdout: "abc\trefs/heads/claude/abcd1234" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ iid: 7, web_url: "https://gh/-/mr/7" }), {
          status: 201,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.openPullRequest?.({
      title: "Fix",
      body: "B",
      draft: true,
    });
    expect(result).toEqual({ url: "https://gh/-/mr/7", number: 7 });
    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(
      `${API_BASE}/projects/${PROJECT_PATH}/merge_requests`,
    );
    expect(callArgs[1].method).toBe("POST");
    expect(JSON.parse(String(callArgs[1].body))).toEqual({
      source_branch: "claude/abcd1234",
      target_branch: "main",
      title: "Fix",
      description: "B",
      draft: true,
    });
  });

  it("rejects when branch was never pushed", async () => {
    const { fake } = buildFakeSpawn({ "ls-remote": { stdout: "" } });
    const fetchMock = vi.fn();
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.openPullRequest?.({ title: "x" })).rejects.toThrow(
      /no commits pushed.*gitPush/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitLabWorkspaceSCM.listPullRequests", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("maps state filter open→opened and projects iid→number, locked→closed", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              iid: 1,
              title: "MR1",
              state: "opened",
              web_url: "https://gl/-/mr/1",
              draft: false,
              author: { username: "alice" },
              source_branch: "feat",
              target_branch: "main",
              merged_at: null,
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-05-02T00:00:00Z",
            },
            {
              iid: 2,
              title: "MR2",
              state: "locked",
              web_url: "u",
              draft: false,
              author: null,
              source_branch: "x",
              target_branch: "main",
              merged_at: null,
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-05-02T00:00:00Z",
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.listPullRequests?.({ state: "open" });
    expect(result?.[0]).toMatchObject({
      number: 1,
      state: "open",
      user: "alice",
    });
    expect(result?.[1]).toMatchObject({
      number: 2,
      state: "closed",
      user: "",
    });

    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("state=opened");
    expect(url).toContain("per_page=100");
  });
});

describe("GitLabWorkspaceSCM.listIssues", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("does NOT filter rows (gitlab keeps issues separate from MRs)", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              iid: 5,
              title: "Bug",
              state: "opened",
              web_url: "u",
              author: { username: "alice" },
              labels: ["bug"],
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-05-02T00:00:00Z",
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.listIssues?.({
      labels: ["bug", "needs-triage"],
    });
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      number: 5,
      state: "open",
      labels: ["bug"],
    });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    const labels = new URL(url).searchParams.get("labels");
    expect(labels).toBe("bug,needs-triage");
  });
});

describe("GitLabWorkspaceSCM.commentIssue / commentPullRequest", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("issue note posts to /issues/:iid/notes", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 99 }), { status: 201 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.commentIssue?.({ number: 7, body: "thanks" });
    expect(out?.commentId).toBe(99);
    expect(out?.url).toContain("/issues/7#note_99");
    const callArgs = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(callArgs[0]).toBe(
      `${API_BASE}/projects/${PROJECT_PATH}/issues/7/notes`,
    );
    expect(JSON.parse(String(callArgs[1].body))).toEqual({ body: "thanks" });
  });

  it("MR note posts to /merge_requests/:iid/notes", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 100 }), { status: 201 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.commentPullRequest?.({
      number: 42,
      body: "looks good",
    });
    expect(out?.commentId).toBe(100);
    expect(out?.url).toContain("/merge_requests/42#note_100");
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe(
      `${API_BASE}/projects/${PROJECT_PATH}/merge_requests/42/notes`,
    );
  });
});

describe("GitLabWorkspaceSCM.searchCode", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gl-scm-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /projects/:id/search?scope=blobs and projects results", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              basename: "useChatSession",
              path: "src/renderer/components/chat/useChatSession.ts",
              ref: "main",
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.searchCode?.({ query: "useChatSession" });
    expect(result?.totalCount).toBe(1);
    expect(result?.items[0]).toMatchObject({
      name: "useChatSession",
      path: "src/renderer/components/chat/useChatSession.ts",
      repo: "acme/sub/app",
    });
    expect(result?.items[0].htmlUrl).toContain(
      "https://gitlab.example.com/acme/sub/app/-/blob/main/",
    );
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain(`/projects/${PROJECT_PATH}/search`);
    expect(url).toContain("scope=blobs");
    expect(url).toContain("per_page=100");
  });
});
