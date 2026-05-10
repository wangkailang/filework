/**
 * GitHubWorkspaceSCM.{listCIRuns,getCIRun,listCIJobs} (M8).
 *
 * Mirrors the github-scm.test.ts harness — fake spawn for the local clone,
 * mocked fetch for the GitHub Actions endpoints. Asserts URL composition,
 * per-status filter passthrough, and `failedSteps` projection from
 * `run.steps[].conclusion === "failure"`.
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

describe("GitHubWorkspaceSCM.listCIRuns", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ci-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /actions/runs with branch + status filters and projects rows", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 999_111_222_333,
                name: "CI",
                status: "completed",
                conclusion: "failure",
                head_branch: "feat/x",
                head_sha: "deadbeef",
                html_url: "https://gh/runs/1",
                run_started_at: "2026-05-10T10:00:00Z",
                updated_at: "2026-05-10T10:05:30Z",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const result = await ws.scm.listCIRuns?.({
      ref: "feat/x",
      status: "completed",
      limit: 50,
    });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/actions/runs?");
    expect(url).toContain("branch=feat%2Fx");
    expect(url).toContain("status=completed");
    expect(url).toContain("per_page=50");
    expect(result).toEqual([
      {
        id: "999111222333",
        name: "CI",
        status: "completed",
        conclusion: "failure",
        ref: "feat/x",
        commitSha: "deadbeef",
        url: "https://gh/runs/1",
        startedAt: "2026-05-10T10:00:00Z",
        completedAt: "2026-05-10T10:05:30Z",
      },
    ]);
  });

  it("clamps limit to 100 and leaves completedAt null while in_progress", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 1,
                name: null,
                workflow_name: "Build",
                status: "in_progress",
                conclusion: null,
                head_branch: "main",
                head_sha: "abc",
                html_url: "https://gh/runs/1",
                run_started_at: "2026-05-10T10:00:00Z",
                updated_at: "2026-05-10T10:01:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.listCIRuns?.({ limit: 500 });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("per_page=100");
    expect(out?.[0]).toMatchObject({
      name: "Build",
      status: "in_progress",
      conclusion: null,
      completedAt: null,
    });
  });
});

describe("GitHubWorkspaceSCM.getCIRun", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ci-cache-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("returns run detail with computed durationSec from start/end", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 42,
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_branch: "main",
            head_sha: "abc",
            html_url: "https://gh/runs/42",
            run_started_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:02:00Z",
            event: "push",
            jobs: { total_count: 3 },
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const detail = await ws.scm.getCIRun?.({ id: "42" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/actions/runs/42");
    expect(detail).toMatchObject({
      id: "42",
      event: "push",
      durationSec: 120,
      jobsCount: 3,
    });
  });
});

describe("GitHubWorkspaceSCM.listCIJobs", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ci-cache-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("projects failedSteps from steps[].conclusion === 'failure'", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 7,
                name: "test",
                status: "completed",
                conclusion: "failure",
                html_url: "https://gh/jobs/7",
                started_at: "2026-05-10T10:00:00Z",
                completed_at: "2026-05-10T10:01:00Z",
                steps: [
                  { name: "checkout", conclusion: "success" },
                  { name: "pnpm test", conclusion: "failure" },
                  { name: "lint", conclusion: "failure" },
                ],
              },
              {
                id: 8,
                name: "build",
                status: "completed",
                conclusion: "success",
                html_url: "https://gh/jobs/8",
                started_at: "2026-05-10T10:00:00Z",
                completed_at: "2026-05-10T10:00:30Z",
                steps: [{ name: "build", conclusion: "success" }],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const jobs = await ws.scm.listCIJobs?.({ runId: "42" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/actions/runs/42/jobs?per_page=100");
    expect(jobs?.[0].failedSteps).toEqual(["pnpm test", "lint"]);
    expect(jobs?.[1].failedSteps).toEqual([]);
  });
});
