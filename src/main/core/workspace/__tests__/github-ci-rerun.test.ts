/**
 * GitHubWorkspaceSCM.{getCIJobLog, rerunCI} (M9).
 *
 * Mirrors github-ci.test.ts harness — fake spawn for the local clone,
 * mocked fetch for the GitHub Actions log + rerun endpoints. Asserts
 * tail slicing, MAX_LAST_LINES cap, rerun path dispatch, and the
 * projectLogTail pure helper.
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

describe("GitHubWorkspaceSCM.getCIJobLog", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghlog-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /actions/jobs/:id/logs and returns last 500 lines by default", async () => {
    const { fake } = buildFakeSpawn();
    const fullLog = Array.from(
      { length: 1200 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const fetchMock = vi.fn(async () => new Response(fullLog, { status: 200 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const log = await ws.scm.getCIJobLog?.({ jobId: "job-7" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/actions/jobs/job-7/logs");
    expect(log?.jobId).toBe("job-7");
    expect(log?.totalLines).toBe(1200);
    expect(log?.truncated).toBe(true);
    // Default lastLines=500 → first kept line is "line 701"
    expect(log?.content.startsWith("line 701\n")).toBe(true);
    expect(log?.content.endsWith("line 1200")).toBe(true);
  });

  it("respects custom lastLines and reports truncated=false when log fits", async () => {
    const { fake } = buildFakeSpawn();
    const fullLog = "a\nb\nc\nd\ne";
    const fetchMock = vi.fn(async () => new Response(fullLog, { status: 200 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const log = await ws.scm.getCIJobLog?.({ jobId: "j", lastLines: 10 });
    expect(log?.truncated).toBe(false);
    expect(log?.content).toBe("a\nb\nc\nd\ne");
    expect(log?.totalLines).toBe(5);
  });

  it("lastLines=0 means unbounded but still capped at 5000", async () => {
    const { fake } = buildFakeSpawn();
    const fullLog = Array.from({ length: 6000 }, (_, i) => String(i)).join(
      "\n",
    );
    const fetchMock = vi.fn(async () => new Response(fullLog, { status: 200 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const log = await ws.scm.getCIJobLog?.({ jobId: "j", lastLines: 0 });
    expect(log?.truncated).toBe(true);
    // 6000 lines → cap at 5000 → first kept line is "1000"
    expect(log?.content.split("\n").length).toBe(5000);
    expect(log?.content.split("\n")[0]).toBe("1000");
  });
});

describe("GitHubWorkspaceSCM.rerunCI", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghrerun-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("failedOnly:true POSTs to /rerun-failed-jobs with empty body", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.rerunCI?.({ runId: "42", failedOnly: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/actions/runs/42/rerun-failed-jobs");
    expect(init.method).toBe("POST");
    expect(out).toEqual({ runId: "42", queued: true });
  });

  it("failedOnly:false POSTs to /rerun (full run)", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.rerunCI?.({ runId: "42", failedOnly: false });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/repos/acme/app/actions/runs/42/rerun");
    expect(url).not.toContain("rerun-failed-jobs");
  });

  it("defaults to failedOnly:true when not specified", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.rerunCI?.({ runId: "42" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/rerun-failed-jobs");
  });

  it("surfaces non-2xx GitHub errors with status + body excerpt", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("Run not in terminal state", { status: 422 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.rerunCI?.({ runId: "42" })).rejects.toThrow(
      /422.*Run not in terminal state/,
    );
  });
});

describe("projectLogTail (pure helper)", () => {
  it("totalLines counts split lines", () => {
    const out = __test__.projectLogTail("j", "a\nb\nc", 100);
    expect(out.totalLines).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it("returns the trailing slice when overflowing", () => {
    const raw = Array.from({ length: 100 }, (_, i) => String(i)).join("\n");
    const out = __test__.projectLogTail("j", raw, 10);
    expect(out.truncated).toBe(true);
    expect(out.content.split("\n")).toEqual([
      "90",
      "91",
      "92",
      "93",
      "94",
      "95",
      "96",
      "97",
      "98",
      "99",
    ]);
  });
});
