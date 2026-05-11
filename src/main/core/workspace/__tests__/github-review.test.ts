/**
 * GitHubWorkspaceSCM.{reviewPullRequest, listCommitChecks} (M10).
 *
 * Same harness as the M8/M9 github-* tests. Asserts the review POST shape
 * (event passthrough, comments[].side="RIGHT") and the check-runs URL +
 * `app.slug` → `source` projection.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __test__, type GitHubRef, GitHubWorkspace } from "../github-workspace";

const buildFakeSpawn = () => {
  const fake = vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      if (args[0] === "clone") {
        const cloneDir = args[args.length - 1];
        mkdir(path.join(cloneDir, ".git"), { recursive: true }).then(() => {
          setImmediate(() => proc.emit("close", 0));
        });
      } else {
        setImmediate(() => proc.emit("close", 0));
      }
      return proc;
    },
  );
  return { fake };
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
  fetchFn: typeof fetch,
): Promise<GitHubWorkspace> => {
  const cloneDir = path.join(cacheDir, "acme", "app@main");
  await mkdir(path.join(cloneDir, ".git"), { recursive: true });
  await writeFile(
    path.join(cloneDir, ".last-fetch"),
    new Date().toISOString(),
    "utf8",
  );
  return GitHubWorkspace.create(fakeRef, {
    resolveToken: async () => "ghp_TEST",
    cacheDir,
    freshnessTtlMs: 60_000,
    // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
    spawnFn: fakeSpawn as any,
    fetchFn,
    sessionScope: "abcd1234",
  });
};

describe("GitHubWorkspaceSCM.reviewPullRequest", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghreview-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /pulls/:n/reviews with event + comments[].side='RIGHT'", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 999, html_url: "https://gh/r/999" }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.reviewPullRequest?.({
      number: 7,
      body: "LGTM with nits",
      event: "COMMENT",
      comments: [
        { path: "src/foo.ts", line: 10, body: "rename this" },
        { path: "src/bar.ts", line: 42, body: "tighten this" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/pulls/7/reviews");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.event).toBe("COMMENT");
    expect(sent.body).toBe("LGTM with nits");
    expect(sent.comments).toHaveLength(2);
    expect(sent.comments[0]).toEqual({
      path: "src/foo.ts",
      line: 10,
      body: "rename this",
      side: "RIGHT",
    });
    expect(out).toEqual({ reviewId: "999", url: "https://gh/r/999" });
  });

  it("omits event when not provided and sends empty comments array", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 1, html_url: "https://gh/r/1" }), {
          status: 200,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.reviewPullRequest?.({ number: 7, body: "thoughts?" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const sent = JSON.parse(init.body as string);
    expect(sent.event).toBeUndefined();
    expect(sent.comments).toEqual([]);
  });
});

describe("GitHubWorkspaceSCM.listCommitChecks", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghchecks-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /commits/:sha/check-runs and projects app.slug to source", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            check_runs: [
              {
                name: "build",
                status: "completed",
                conclusion: "success",
                html_url: "https://gh/c/1",
                app: { slug: "github-actions" },
              },
              {
                name: "ci/circleci: deploy",
                status: "completed",
                conclusion: "failure",
                html_url: "https://gh/c/2",
                app: { slug: "circleci" },
              },
              {
                name: "legacy",
                status: "in_progress",
                conclusion: null,
                html_url: "https://gh/c/3",
                app: null,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.listCommitChecks?.({ sha: "deadbeef" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/commits/deadbeef/check-runs");
    expect(url).toContain("per_page=100");
    expect(out).toEqual([
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        url: "https://gh/c/1",
        source: "github-actions",
      },
      {
        name: "ci/circleci: deploy",
        status: "completed",
        conclusion: "failure",
        url: "https://gh/c/2",
        source: "circleci",
      },
      {
        name: "legacy",
        status: "in_progress",
        conclusion: null,
        url: "https://gh/c/3",
        source: "unknown",
      },
    ]);
  });
});

describe("toCommitCheckFromGH (pure helper)", () => {
  it("falls back to 'unknown' when app.slug is null", () => {
    const out = __test__.toCommitCheckFromGH({
      name: "x",
      status: "queued",
      conclusion: null,
      html_url: "https://gh/c/9",
      app: { slug: null },
    });
    expect(out.source).toBe("unknown");
  });
});
