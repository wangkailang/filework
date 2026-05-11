/**
 * GitHubWorkspaceSCM.{cancelCI, listWorkflows, dispatchWorkflow} (M11).
 *
 * Same harness as the M8/M9/M10 github-* tests. Asserts:
 *   - cancelCI POSTs to /actions/runs/:id/cancel with empty body
 *   - listWorkflows hits /actions/workflows and projects {id, name, path, state}
 *   - dispatchWorkflow POSTs to /actions/workflows/:id/dispatches with {ref, inputs}
 *   - dispatchWorkflow without inputs sends {ref} only (not undefined)
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

describe("GitHubWorkspaceSCM.cancelCI", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghcancel-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /actions/runs/:id/cancel with no body", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.cancelCI?.({ runId: "42" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/repos/acme/app/actions/runs/42/cancel");
    expect(init.method).toBe("POST");
    // Critical: body must be undefined, NOT the literal string "undefined".
    expect(init.body).toBeUndefined();
    expect(out).toEqual({ runId: "42", cancelled: true });
  });

  it("surfaces 409 conflict (run already terminal) as a friendly error", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response("Cannot cancel a workflow run in completed state", {
          status: 409,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.cancelCI?.({ runId: "42" })).rejects.toThrow(
      /409.*Cannot cancel/,
    );
  });
});

describe("GitHubWorkspaceSCM.listWorkflows", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghwf-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("hits /actions/workflows and projects to WorkflowSummary[]", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            total_count: 2,
            workflows: [
              {
                id: 100,
                name: "CI",
                path: ".github/workflows/ci.yml",
                state: "active",
              },
              {
                id: 200,
                name: "Release",
                path: ".github/workflows/release.yml",
                state: "disabled_manually",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.listWorkflows?.();
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/repos/acme/app/actions/workflows");
    expect(url).toContain("per_page=100");
    expect(out).toEqual([
      {
        id: "100",
        name: "CI",
        path: ".github/workflows/ci.yml",
        state: "active",
      },
      {
        id: "200",
        name: "Release",
        path: ".github/workflows/release.yml",
        state: "disabled_manually",
      },
    ]);
  });
});

describe("GitHubWorkspaceSCM.dispatchWorkflow", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-ghdispatch-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /workflows/:id/dispatches with {ref, inputs} body", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.dispatchWorkflow?.({
      workflowFile: "ci.yml",
      ref: "main",
      inputs: { env: "staging", verbose: "true" },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain(
      "/repos/acme/app/actions/workflows/ci.yml/dispatches",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      ref: "main",
      inputs: { env: "staging", verbose: "true" },
    });
    expect(out).toEqual({
      workflowFile: "ci.yml",
      ref: "main",
      queued: true,
    });
  });

  it("omits inputs key when not provided (sends just {ref})", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.dispatchWorkflow?.({ workflowFile: "ci.yml", ref: "main" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ ref: "main" });
    expect("inputs" in sent).toBe(false);
  });

  it("URL-encodes the workflow filename so '/' in a path doesn't break", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await ws.scm.dispatchWorkflow?.({
      workflowFile: ".github/workflows/ci.yml",
      ref: "main",
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain(
      "/actions/workflows/.github%2Fworkflows%2Fci.yml/dispatches",
    );
  });

  it("surfaces 422 (workflow_dispatch not declared) as a friendly error", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response("Workflow does not have 'workflow_dispatch' trigger", {
          status: 422,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(
      ws.scm.dispatchWorkflow?.({ workflowFile: "ci.yml", ref: "main" }),
    ).rejects.toThrow(/422.*workflow_dispatch/);
  });
});

describe("toWorkflowSummary (pure helper)", () => {
  it("converts numeric id to string", () => {
    const out = __test__.toWorkflowSummary({
      id: 999,
      name: "X",
      path: ".github/workflows/x.yml",
      state: "active",
    });
    expect(out.id).toBe("999");
  });
});
