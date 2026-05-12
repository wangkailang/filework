/**
 * GitHubWorkspaceSCM.{listPullRequestReviewComments,
 * editPullRequestReviewComment, deletePullRequestReviewComment} (M17).
 *
 * Asserts:
 *   - listPullRequestReviewComments GETs /pulls/:n/comments?per_page=100
 *     and projects {id, reviewId, author, path, line, body, url,
 *     createdAt, updatedAt} including null-line / null-reviewId /
 *     missing-user fallbacks
 *   - editPullRequestReviewComment PATCHes /pulls/comments/:id with {body},
 *     returns {commentId, url}
 *   - deletePullRequestReviewComment DELETEs /pulls/comments/:id (204),
 *     returns {commentId, deleted:true}
 *   - Surfaces 403 "not the author" + 404 verbatim
 *   - toPullRequestReviewCommentSummary projection: numeric id → string,
 *     null reviewId / null user / null line preserved
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type GitHubRef,
  GitHubWorkspace,
  __test__ as githubTest,
} from "../github-workspace";

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

describe("GitHubWorkspaceSCM.listPullRequestReviewComments", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghlistcom-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("GETs /pulls/:n/comments?per_page=100 and projects fields", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 11,
              pull_request_review_id: 99,
              user: { login: "alice" },
              path: "src/a.ts",
              line: 42,
              body: "use let",
              html_url: "https://github.com/acme/app/pull/7#discussion_r11",
              created_at: "2026-05-12T00:00:00Z",
              updated_at: "2026-05-12T00:01:00Z",
            },
            {
              id: 12,
              pull_request_review_id: null,
              user: null,
              path: "src/b.ts",
              line: null,
              body: "outdated note",
              html_url: "https://github.com/acme/app/pull/7#discussion_r12",
              created_at: "2026-05-12T00:00:00Z",
              updated_at: "2026-05-12T00:00:00Z",
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.listPullRequestReviewComments?.({ number: 7 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toContain("/repos/acme/app/pulls/7/comments?per_page=100");
    expect(init?.method ?? "GET").not.toBe("PATCH");
    expect(out).toEqual([
      {
        id: "11",
        reviewId: "99",
        author: "alice",
        path: "src/a.ts",
        line: 42,
        body: "use let",
        url: "https://github.com/acme/app/pull/7#discussion_r11",
        createdAt: "2026-05-12T00:00:00Z",
        updatedAt: "2026-05-12T00:01:00Z",
      },
      {
        id: "12",
        reviewId: null,
        author: "(unknown)",
        path: "src/b.ts",
        line: null,
        body: "outdated note",
        url: "https://github.com/acme/app/pull/7#discussion_r12",
        createdAt: "2026-05-12T00:00:00Z",
        updatedAt: "2026-05-12T00:00:00Z",
      },
    ]);
  });
});

describe("GitHubWorkspaceSCM.editPullRequestReviewComment", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghedit-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("PATCHes /pulls/comments/:id with {body} and returns {commentId, url}", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 12345,
            html_url: "https://github.com/acme/app/pull/7#discussion_r12345",
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.editPullRequestReviewComment?.({
      commentId: "12345",
      body: "use let, not const",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/pulls/comments/12345");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      body: "use let, not const",
    });
    expect(out).toEqual({
      commentId: "12345",
      url: "https://github.com/acme/app/pull/7#discussion_r12345",
    });
  });

  it("surfaces 403 'not the author' verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ message: "Must be authenticated as the author" }),
          { status: 403 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.editPullRequestReviewComment?.({
        commentId: "12345",
        body: "x",
      }),
    ).rejects.toThrow(/403.*authenticated as the author/);
  });

  it("surfaces 404 for missing comment verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.editPullRequestReviewComment?.({
        commentId: "99999",
        body: "x",
      }),
    ).rejects.toThrow(/404.*Not Found/);
  });
});

describe("GitHubWorkspaceSCM.deletePullRequestReviewComment", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghdel-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("DELETEs /pulls/comments/:id (204) and returns {commentId, deleted:true}", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.deletePullRequestReviewComment?.({
      commentId: "12346",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/pulls/comments/12346");
    expect(init.method).toBe("DELETE");
    expect(out).toEqual({ commentId: "12346", deleted: true });
  });

  it("surfaces 404 for missing comment verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.deletePullRequestReviewComment?.({ commentId: "99999" }),
    ).rejects.toThrow(/404.*Not Found/);
  });
});

describe("toPullRequestReviewCommentSummary projection (M17)", () => {
  it("falls back to (unknown) author when user is null", () => {
    const out = githubTest.toPullRequestReviewCommentSummary({
      id: 1,
      pull_request_review_id: null,
      user: null,
      path: "x.ts",
      line: null,
      body: "b",
      html_url: "https://example/c/1",
      created_at: "2026-05-12T00:00:00Z",
      updated_at: "2026-05-12T00:00:00Z",
    });
    expect(out.author).toBe("(unknown)");
    expect(out.reviewId).toBeNull();
    expect(out.line).toBeNull();
    expect(out.id).toBe("1");
  });

  it("stringifies numeric ids", () => {
    const out = githubTest.toPullRequestReviewCommentSummary({
      id: 42,
      pull_request_review_id: 99,
      user: { login: "u" },
      path: "x.ts",
      line: 5,
      body: "b",
      html_url: "https://example/c/42",
      created_at: "2026-05-12T00:00:00Z",
      updated_at: "2026-05-12T00:00:00Z",
    });
    expect(out.id).toBe("42");
    expect(out.reviewId).toBe("99");
  });
});
