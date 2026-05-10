/**
 * GitLabWorkspaceSCM.{listCIRuns,getCIRun,listCIJobs} (M8).
 *
 * Mirrors the gitlab-scm.test.ts harness — fake spawn for the local clone,
 * mocked fetch for the GitLab pipeline endpoints. Verifies URL composition,
 * the input-status → query mapping (in_progress→running, completed→success),
 * and the output status/conclusion mapping for every GitLab pipeline state.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __test__, type GitLabRef, GitLabWorkspace } from "../gitlab-workspace";

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

describe("GitLabWorkspaceSCM.listCIRuns", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glci-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /pipelines with ref + mapped status filter, projects rows", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 12345,
              name: "pipe",
              status: "failed",
              ref: "feat/x",
              sha: "deadbeef",
              web_url: "https://gl/pipelines/12345",
              created_at: "2026-05-10T10:00:00Z",
              updated_at: "2026-05-10T10:05:30Z",
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.listCIRuns?.({
      ref: "feat/x",
      status: "in_progress",
      limit: 10,
    });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/projects/acme%2Fsub%2Fapp/pipelines?");
    expect(url).toContain("ref=feat%2Fx");
    expect(url).toContain("status=running"); // mapped from in_progress
    expect(url).toContain("per_page=10");
    expect(out).toEqual([
      {
        id: "12345",
        name: "pipe",
        status: "completed",
        conclusion: "failure",
        ref: "feat/x",
        commitSha: "deadbeef",
        url: "https://gl/pipelines/12345",
        startedAt: "2026-05-10T10:00:00Z",
        completedAt: "2026-05-10T10:05:30Z",
      },
    ]);
  });

  it("status=completed maps to GitLab status=success", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify([]), { status: 200 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.listCIRuns?.({ status: "completed" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("status=success");
  });
});

describe("GitLabWorkspaceSCM.getCIRun", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glci-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /pipelines/:id and projects detail (event from source, jobsCount=0)", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 42,
            status: "success",
            ref: "main",
            sha: "abc",
            web_url: "https://gl/pipelines/42",
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:02:00Z",
            source: "push",
            duration: 95,
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const detail = await ws.scm.getCIRun?.({ id: "42" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/projects/acme%2Fsub%2Fapp/pipelines/42");
    expect(detail).toMatchObject({
      id: "42",
      status: "completed",
      conclusion: "success",
      event: "push",
      durationSec: 95,
      jobsCount: 0,
    });
  });
});

describe("GitLabWorkspaceSCM.listCIJobs", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glci-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits per-pipeline jobs endpoint and leaves failedSteps empty", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 7,
              name: "test",
              status: "failed",
              web_url: "https://gl/jobs/7",
              started_at: "2026-05-10T10:00:00Z",
              finished_at: "2026-05-10T10:01:00Z",
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const jobs = await ws.scm.listCIJobs?.({ runId: "42" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain(
      "/projects/acme%2Fsub%2Fapp/pipelines/42/jobs?per_page=100",
    );
    expect(jobs?.[0]).toMatchObject({
      id: "7",
      status: "completed",
      conclusion: "failure",
      failedSteps: [],
    });
  });
});

describe("mapPipelineStatus", () => {
  it("covers the full GitLab status union", () => {
    const cases: Array<
      [
        Parameters<typeof __test__.mapPipelineStatus>[0],
        ReturnType<typeof __test__.mapPipelineStatus>,
      ]
    > = [
      ["created", { status: "queued", conclusion: null }],
      ["pending", { status: "queued", conclusion: null }],
      ["scheduled", { status: "queued", conclusion: null }],
      ["preparing", { status: "queued", conclusion: null }],
      ["running", { status: "in_progress", conclusion: null }],
      ["success", { status: "completed", conclusion: "success" }],
      ["failed", { status: "completed", conclusion: "failure" }],
      ["canceled", { status: "completed", conclusion: "cancelled" }],
      ["skipped", { status: "completed", conclusion: "skipped" }],
      ["manual", { status: "completed", conclusion: "action_required" }],
    ];
    for (const [input, expected] of cases) {
      expect(__test__.mapPipelineStatus(input)).toEqual(expected);
    }
  });
});
