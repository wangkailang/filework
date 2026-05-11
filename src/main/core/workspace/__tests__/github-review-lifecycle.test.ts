/**
 * GitHubWorkspaceSCM.{dismissPullRequestReview, editPullRequestReviewBody} (M15).
 *
 * Both endpoints are PUT to GitHub. Asserts URL composition, body shape,
 * and result projection ({reviewId, dismissed:true} / {reviewId, url}).
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type GitHubRef, GitHubWorkspace } from "../github-workspace";

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

describe("GitHubWorkspaceSCM.dismissPullRequestReview", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghdismiss-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("PUTs to /pulls/:n/reviews/:id/dismissals with {message, event:'DISMISS'}", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 999, state: "DISMISSED" }), {
          status: 200,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.dismissPullRequestReview?.({
      number: 7,
      reviewId: "999",
      message: "verdict was hasty",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/pulls/7/reviews/999/dismissals");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      message: "verdict was hasty",
      event: "DISMISS",
    });
    expect(out).toEqual({ reviewId: "999", dismissed: true });
  });

  it("surfaces non-2xx GitHub errors verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("Validation Failed", { status: 422 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.dismissPullRequestReview?.({
        number: 7,
        reviewId: "999",
        message: "x",
      }),
    ).rejects.toThrow(/422.*Validation Failed/);
  });
});

describe("GitHubWorkspaceSCM.editPullRequestReviewBody", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghedit-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("PUTs to /pulls/:n/reviews/:id with {body} and projects html_url", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, html_url: "https://gh/r/42" }), {
          status: 200,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.editPullRequestReviewBody?.({
      number: 7,
      reviewId: "42",
      body: "final review",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/pulls/7/reviews/42");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ body: "final review" });
    expect(out).toEqual({ reviewId: "42", url: "https://gh/r/42" });
  });

  it("surfaces 422 on edit of dismissed review", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("review is dismissed", { status: 422 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.editPullRequestReviewBody?.({
        number: 7,
        reviewId: "42",
        body: "x",
      }),
    ).rejects.toThrow(/422.*review is dismissed/);
  });
});
