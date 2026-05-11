/**
 * GitLabWorkspaceSCM.{approveMergeRequest, unapproveMergeRequest,
 * listMergeRequestApprovalRules} (M16).
 *
 * Asserts:
 *   - approveMergeRequest POSTs to /merge_requests/:iid/approve, returns
 *     {number, approved:true}
 *   - unapproveMergeRequest POSTs to /merge_requests/:iid/unapprove,
 *     returns {number, approved:false}
 *   - listMergeRequestApprovalRules GETs /merge_requests/:iid/approval_rules
 *     and projects {id, name, ruleType, approvalsRequired, eligibleApprovers}
 *   - "Already approved" 401 surfaces verbatim
 *   - toApprovalRule projection: numeric id → string, snake_case → camelCase,
 *     usernames-only from eligible_approvers, empty list when missing
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type GitLabRef,
  GitLabWorkspace,
  __test__ as gitlabTest,
} from "../gitlab-workspace";

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

describe("GitLabWorkspaceSCM.approveMergeRequest", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glapprove-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /merge_requests/:iid/approve with empty body", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 7, iid: 7, approved_by: [{ user: {} }] }),
          { status: 201 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.approveMergeRequest?.({ number: 7 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain(
      "/projects/acme%2Fsub%2Fapp/merge_requests/7/approve",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(out).toEqual({ number: 7, approved: true });
  });

  it("surfaces 401 'You have already approved' verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: "401 You have already approved this merge request",
          }),
          { status: 401 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.approveMergeRequest?.({ number: 7 })).rejects.toThrow(
      /already approved/,
    );
  });
});

describe("GitLabWorkspaceSCM.unapproveMergeRequest", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-glunapprove-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("POSTs to /merge_requests/:iid/unapprove with empty body", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.unapproveMergeRequest?.({ number: 9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain(
      "/projects/acme%2Fsub%2Fapp/merge_requests/9/unapprove",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(out).toEqual({ number: 9, approved: false });
  });

  it("surfaces 404 'not approved by you' verbatim", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response("404 You did not approve this merge request", {
          status: 404,
        }),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    await expect(ws.scm.unapproveMergeRequest?.({ number: 9 })).rejects.toThrow(
      /404.*did not approve/,
    );
  });
});

describe("GitLabWorkspaceSCM.listMergeRequestApprovalRules", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "fw-gllistrules-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("GETs /merge_requests/:iid/approval_rules and projects fields", async () => {
    const { fake } = buildFakeSpawn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 11,
              name: "Default",
              rule_type: "regular",
              approvals_required: 2,
              eligible_approvers: [
                { username: "alice", id: 1 },
                { username: "bob", id: 2 },
              ],
            },
            {
              id: 12,
              name: "QA",
              rule_type: "code_owner",
              approvals_required: 1,
              // eligible_approvers omitted
            },
          ]),
          { status: 200 },
        ),
    );
    const ws = await buildWorkspace(cacheDir, fake, fetchMock);
    const out = await ws.scm.listMergeRequestApprovalRules?.({ number: 7 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain(
      "/projects/acme%2Fsub%2Fapp/merge_requests/7/approval_rules",
    );
    // glJson is a GET helper — method must not be "POST".
    expect(init.method ?? "GET").not.toBe("POST");
    expect(out).toEqual([
      {
        id: "11",
        name: "Default",
        ruleType: "regular",
        approvalsRequired: 2,
        eligibleApprovers: ["alice", "bob"],
      },
      {
        id: "12",
        name: "QA",
        ruleType: "code_owner",
        approvalsRequired: 1,
        eligibleApprovers: [],
      },
    ]);
  });
});

describe("toApprovalRule projection (M16)", () => {
  it("converts numeric id to string and projects usernames-only", () => {
    const rule = gitlabTest.toApprovalRule({
      id: 42,
      name: "X",
      rule_type: "any_approver",
      approvals_required: 0,
      eligible_approvers: [{ username: "u1" }, { username: "u2" }],
    });
    expect(rule).toEqual({
      id: "42",
      name: "X",
      ruleType: "any_approver",
      approvalsRequired: 0,
      eligibleApprovers: ["u1", "u2"],
    });
  });

  it("returns empty eligibleApprovers when raw field missing", () => {
    const rule = gitlabTest.toApprovalRule({
      id: 1,
      name: "Y",
      rule_type: "regular",
      approvals_required: 1,
    });
    expect(rule.eligibleApprovers).toEqual([]);
  });
});
