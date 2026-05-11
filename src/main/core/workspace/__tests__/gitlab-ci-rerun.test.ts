/**
 * GitLabWorkspaceSCM.{getCIJobLog, rerunCI} (M9).
 *
 * Mirrors gitlab-ci.test.ts harness — fake spawn for the local clone,
 * mocked fetch for the GitLab job-trace + retry endpoints. Asserts URL
 * composition and the deliberate "full re-run is not supported" throw
 * on GitLab.
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

describe("GitLabWorkspaceSCM.getCIJobLog", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gllog-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /jobs/:id/trace and slices to last 500 lines by default", async () => {
    const { fake } = buildFakeSpawn();
    const fullLog = Array.from({ length: 700 }, (_, i) => `t${i}`).join("\n");
    const fetchMock = vi.fn(async () => new Response(fullLog, { status: 200 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const log = await ws.scm.getCIJobLog?.({ jobId: "9001" });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/projects/acme%2Fsub%2Fapp/jobs/9001/trace");
    expect(log?.totalLines).toBe(700);
    expect(log?.truncated).toBe(true);
    expect(log?.content.split("\n").length).toBe(500);
  });

  it("returns full content when log fits within lastLines", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("only one line", { status: 200 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const log = await ws.scm.getCIJobLog?.({ jobId: "1", lastLines: 100 });
    expect(log?.truncated).toBe(false);
    expect(log?.content).toBe("only one line");
  });
});

describe("GitLabWorkspaceSCM.rerunCI", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glrerun-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("failedOnly:true POSTs to /pipelines/:id/retry and returns queued", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 42 }), { status: 201 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.rerunCI?.({ runId: "42", failedOnly: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/projects/acme%2Fsub%2Fapp/pipelines/42/retry");
    expect(init.method).toBe("POST");
    expect(out).toEqual({ runId: "42", queued: true });
  });

  it("defaults to failedOnly:true (the only supported mode)", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 42 }), { status: 201 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.rerunCI?.({ runId: "42" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/retry");
  });

  it("failedOnly:false throws with a friendly message and never POSTs", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.rerunCI?.({ runId: "42", failedOnly: false }),
    ).rejects.toThrow(/GitLab.*full pipeline re-run/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
