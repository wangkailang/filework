/**
 * GitLabWorkspaceSCM.cancelCI (M11).
 *
 * Asserts:
 *   - cancelCI POSTs to /pipelines/:id/cancel
 *   - Returns {runId, cancelled: true}, discarding the pipeline body
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

describe("GitLabWorkspaceSCM.cancelCI", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glcancel-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /pipelines/:id/cancel and returns {runId, cancelled: true}", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, status: "canceled" }), {
          status: 200,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.cancelCI?.({ runId: "42" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/projects/acme%2Fsub%2Fapp/pipelines/42/cancel");
    expect(init.method).toBe("POST");
    expect(out).toEqual({ runId: "42", cancelled: true });
  });

  it("URL-encodes the runId", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 1, status: "canceled" }), {
          status: 200,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    // GitLab pipeline ids are numeric in practice, but the contract
    // accepts string — must encode in case the agent passes funky chars.
    await ws.scm.cancelCI?.({ runId: "ns/x" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/pipelines/ns%2Fx/cancel");
  });

  it("surfaces non-2xx GitLab errors verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("Pipeline already finished", { status: 400 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.cancelCI?.({ runId: "42" })).rejects.toThrow(
      /400.*Pipeline already finished/,
    );
  });
});
