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

  it("rewrites remote with current PAT and pushes -u origin <branch>", async () => {
    const { fake, calls } = buildFakeSpawn();
    const ws = await buildWorkspace(cacheDir, fake);

    const result = await ws.scm.push?.({});

    expect(result).toEqual({ branch: "claude/abcd1234", remote: "origin" });
    const remoteCall = calls.find((c) => c.args[0] === "remote");
    expect(remoteCall?.args[0]).toBe("remote");
    expect(remoteCall?.args[1]).toBe("set-url");
    expect(remoteCall?.args[3]).toMatch(
      /^https:\/\/x-access-token:ghp_TESTTOKEN@github\.com\/acme\/app\.git$/,
    );
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
