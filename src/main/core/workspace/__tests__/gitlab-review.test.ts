/**
 * GitLabWorkspaceSCM.{reviewPullRequest, listCommitChecks} (M10).
 *
 * Asserts:
 *   - reviewPullRequest first GETs /merge_requests/:n for diff_refs, then
 *     POSTs N positional discussions + 1 summary note (when body provided).
 *   - "needs at least one comment or body" guard fires when both empty.
 *   - listCommitChecks hits /repository/commits/:sha/statuses and uses
 *     the M8 `mapPipelineStatus` mapping.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type GitLabRef, GitLabWorkspace } from "../gitlab-workspace";

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
  fetchFn: typeof fetch,
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
    resolveToken: async () => "glpat-TEST",
    cacheDir,
    freshnessTtlMs: 60_000,
    // biome-ignore lint/suspicious/noExplicitAny: test stub for spawn
    spawnFn: fakeSpawn as any,
    fetchFn,
    sessionScope: "abcd1234",
  });
};

/**
 * Returns a vi.fn() fetch mock that responds in sequence. Each step is a
 * function returning a Response. When call count exceeds `steps.length`,
 * the last step is reused. Callers cast to `typeof fetch` at the
 * workspace boundary; the bare Mock type is preserved here so test
 * assertions can read `.mock.calls`.
 */
const sequencedFetch = (
  steps: Array<(url: string, init?: RequestInit) => Response>,
) => {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return step(String(input), init);
  });
};

describe("GitLabWorkspaceSCM.reviewPullRequest", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glreview-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("fetches MR detail then POSTs N discussions + summary note", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = sequencedFetch([
      // 1. GET MR detail
      () =>
        new Response(
          JSON.stringify({
            iid: 7,
            web_url: "https://gl/-/mr/7",
            state: "opened",
            title: "WIP",
            source_branch: "feat/x",
            target_branch: "main",
            author: null,
            merged_at: null,
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:00:00Z",
            description: null,
            diff_refs: {
              base_sha: "BASE",
              head_sha: "HEAD",
              start_sha: "START",
            },
          }),
          { status: 200 },
        ),
      // 2. POST discussion #1
      () => new Response(JSON.stringify({ id: "disc-1" }), { status: 201 }),
      // 3. POST discussion #2
      () => new Response(JSON.stringify({ id: "disc-2" }), { status: 201 }),
      // 4. POST summary note
      () => new Response(JSON.stringify({ id: 99 }), { status: 201 }),
    ]);

    const ws = await buildWorkspace(
      cacheDir,
      fake,
      fetchMock as unknown as typeof fetch,
    );
    const out = await ws.scm.reviewPullRequest?.({
      number: 7,
      body: "overall LGTM",
      comments: [
        { path: "src/foo.ts", line: 10, body: "rename" },
        { path: "src/bar.ts", line: 42, body: "tighten" },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);

    // GET first
    const [getUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(getUrl).toContain("/projects/acme%2Fsub%2Fapp/merge_requests/7");

    // First discussion POST has the right position payload
    const [d1Url, d1Init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(d1Url).toContain("/merge_requests/7/discussions");
    const sent1 = JSON.parse(d1Init.body as string);
    expect(sent1.body).toBe("rename");
    expect(sent1.position).toEqual({
      base_sha: "BASE",
      head_sha: "HEAD",
      start_sha: "START",
      position_type: "text",
      new_path: "src/foo.ts",
      new_line: 10,
    });

    // Summary note POST
    const [noteUrl, noteInit] = fetchMock.mock.calls[3] as unknown as [
      string,
      RequestInit,
    ];
    expect(noteUrl).toContain("/merge_requests/7/notes");
    expect(JSON.parse(noteInit.body as string)).toEqual({
      body: "overall LGTM",
    });

    // First discussion id wins.
    expect(out?.reviewId).toBe("disc-1");
    expect(out?.url).toContain("note_disc-1");
  });

  it("returns the summary note id when no inline comments are provided", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = sequencedFetch([
      () =>
        new Response(
          JSON.stringify({
            iid: 7,
            web_url: "https://gl/-/mr/7",
            state: "opened",
            title: "WIP",
            source_branch: "feat/x",
            target_branch: "main",
            author: null,
            merged_at: null,
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:00:00Z",
            description: null,
            diff_refs: { base_sha: "B", head_sha: "H", start_sha: "S" },
          }),
          { status: 200 },
        ),
      () => new Response(JSON.stringify({ id: 42 }), { status: 201 }),
    ]);
    const ws = await buildWorkspace(
      cacheDir,
      fake,
      fetchMock as unknown as typeof fetch,
    );
    const out = await ws.scm.reviewPullRequest?.({ number: 7, body: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out?.reviewId).toBe("42");
  });

  it("throws when neither comments nor body are provided", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = sequencedFetch([
      () =>
        new Response(
          JSON.stringify({
            iid: 7,
            web_url: "https://gl/-/mr/7",
            state: "opened",
            title: "WIP",
            source_branch: "feat/x",
            target_branch: "main",
            author: null,
            merged_at: null,
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:00:00Z",
            description: null,
            diff_refs: { base_sha: "B", head_sha: "H", start_sha: "S" },
          }),
          { status: 200 },
        ),
    ]);
    const ws = await buildWorkspace(
      cacheDir,
      fake,
      fetchMock as unknown as typeof fetch,
    );
    await expect(ws.scm.reviewPullRequest?.({ number: 7 })).rejects.toThrow(
      /at least one comment or a body/,
    );
    // Only the GET happened — no POSTs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GitLabWorkspaceSCM.listCommitChecks", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glchecks-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /repository/commits/:sha/statuses and projects via mapPipelineStatus", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              name: "build",
              status: "success",
              target_url: "https://gl/-/jobs/1",
            },
            {
              name: "test",
              status: "failed",
              target_url: "https://gl/-/jobs/2",
            },
            {
              name: "deploy",
              status: "running",
              target_url: null,
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(
      cacheDir,
      fake,
      fetchMock as unknown as typeof fetch,
    );
    const out = await ws.scm.listCommitChecks?.({ sha: "deadbeef" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain(
      "/projects/acme%2Fsub%2Fapp/repository/commits/deadbeef/statuses",
    );
    expect(out).toEqual([
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        url: "https://gl/-/jobs/1",
        source: "gitlab_ci",
      },
      {
        name: "test",
        status: "completed",
        conclusion: "failure",
        url: "https://gl/-/jobs/2",
        source: "gitlab_ci",
      },
      {
        name: "deploy",
        status: "in_progress",
        conclusion: null,
        url: "",
        source: "gitlab_ci",
      },
    ]);
  });
});
