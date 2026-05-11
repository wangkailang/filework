/**
 * GitLabWorkspaceSCM.createCIPipeline (M14).
 *
 * Asserts:
 *   - POST to /projects/:id/pipeline with body {ref}
 *   - With variables: body has [{key, value, variable_type:"env_var"}]
 *   - Returns {runId, queued:true, ref}
 *   - Surfaces non-2xx errors verbatim
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

describe("GitLabWorkspaceSCM.createCIPipeline", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glcreate-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /projects/:id/pipeline with {ref} only when no variables", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, status: "pending" }), {
          status: 201,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.createCIPipeline?.({ ref: "main" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/projects/acme%2Fsub%2Fapp/pipeline");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ ref: "main" });
    expect("variables" in sent).toBe(false);
    expect(out).toEqual({ runId: "42", queued: true, ref: "main" });
  });

  it("transforms variables to GitLab's [{key, value, variable_type}] shape", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 99 }), { status: 201 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.createCIPipeline?.({
      ref: "feat/x",
      variables: { ENV: "staging", VERBOSE: "true" },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const sent = JSON.parse(init.body as string);
    expect(sent.ref).toBe("feat/x");
    expect(sent.variables).toEqual([
      { key: "ENV", value: "staging", variable_type: "env_var" },
      { key: "VERBOSE", value: "true", variable_type: "env_var" },
    ]);
  });

  it("surfaces non-2xx GitLab errors verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () => new Response("Reference not found", { status: 400 }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.createCIPipeline?.({ ref: "nope" })).rejects.toThrow(
      /400.*Reference not found/,
    );
  });
});
