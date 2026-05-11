/**
 * PR review + commit-checks tools (M10) — github + gitlab.
 *
 * Same fakeWorkspace harness as ci-tools.test.ts. Verifies registration,
 * safety, schema bounds, and that each tool delegates to the correct SCM
 * method with the right shape (notably: GitLab's review tool ignores any
 * `event` argument because its schema doesn't expose one).
 */

import { describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../workspace/types";
import {
  buildGithubTools,
  githubListCommitChecksTool,
  githubReviewPullRequestTool,
} from "../tools/github-tools";
import {
  buildGitlabTools,
  gitlabListCommitStatusesTool,
  gitlabReviewMergeRequestTool,
} from "../tools/gitlab-tools";

const fakeWorkspace = (scm?: Partial<WorkspaceSCM>): Workspace =>
  ({
    id: "test:scm",
    kind: "github",
    root: "/tmp/clone",
    fs: {} as never,
    exec: {} as never,
    scm: scm as WorkspaceSCM | undefined,
  }) as Workspace;

const fakeCtx = (workspace: Workspace) => ({
  workspace,
  signal: new AbortController().signal,
  toolCallId: "t-rev",
});

describe("M10 review/checks tools — registration", () => {
  it("buildGithubTools exposes review + checks tools", () => {
    const names = buildGithubTools().map((t) => t.name);
    expect(names).toContain("githubReviewPullRequest");
    expect(names).toContain("githubListCommitChecks");
  });

  it("buildGitlabTools exposes review + statuses tools", () => {
    const names = buildGitlabTools().map((t) => t.name);
    expect(names).toContain("gitlabReviewMergeRequest");
    expect(names).toContain("gitlabListCommitStatuses");
  });

  it("review tools are destructive; list tools are safe", () => {
    expect(githubReviewPullRequestTool.safety).toBe("destructive");
    expect(gitlabReviewMergeRequestTool.safety).toBe("destructive");
    expect(githubListCommitChecksTool.safety).toBe("safe");
    expect(gitlabListCommitStatusesTool.safety).toBe("safe");
  });
});

describe("M10 review tools — delegation", () => {
  it("githubReviewPullRequest forwards full payload to scm.reviewPullRequest", async () => {
    const reviewPullRequest = vi.fn(
      async () => ({ reviewId: "x", url: "https://gh/r/x" }) as never,
    );
    const ws = fakeWorkspace({ reviewPullRequest });
    await githubReviewPullRequestTool.execute(
      {
        number: 7,
        body: "ok",
        event: "COMMENT",
        comments: [{ path: "a.ts", line: 1, body: "nit" }],
      },
      fakeCtx(ws),
    );
    expect(reviewPullRequest).toHaveBeenCalledWith({
      number: 7,
      body: "ok",
      event: "COMMENT",
      comments: [{ path: "a.ts", line: 1, body: "nit" }],
    });
  });

  it("gitlabReviewMergeRequest forwards payload (no event)", async () => {
    const reviewPullRequest = vi.fn(
      async () => ({ reviewId: "y", url: "https://gl/r/y" }) as never,
    );
    const ws = fakeWorkspace({ reviewPullRequest });
    await gitlabReviewMergeRequestTool.execute(
      {
        number: 9,
        body: "lgtm",
        comments: [{ path: "b.ts", line: 5, body: "fix" }],
      },
      fakeCtx(ws),
    );
    expect(reviewPullRequest).toHaveBeenCalledWith({
      number: 9,
      body: "lgtm",
      comments: [{ path: "b.ts", line: 5, body: "fix" }],
    });
  });
});

describe("M10 list-checks tools — delegation", () => {
  it("githubListCommitChecks forwards sha to scm.listCommitChecks", async () => {
    const listCommitChecks = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listCommitChecks });
    await githubListCommitChecksTool.execute({ sha: "deadbeef" }, fakeCtx(ws));
    expect(listCommitChecks).toHaveBeenCalledWith({ sha: "deadbeef" });
  });

  it("gitlabListCommitStatuses forwards sha to scm.listCommitChecks", async () => {
    const listCommitChecks = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listCommitChecks });
    await gitlabListCommitStatusesTool.execute(
      { sha: "deadbeef" },
      fakeCtx(ws),
    );
    expect(listCommitChecks).toHaveBeenCalledWith({ sha: "deadbeef" });
  });

  it("throws when scm.listCommitChecks is missing", async () => {
    const ws = fakeWorkspace({});
    await expect(
      githubListCommitChecksTool.execute({ sha: "x" }, fakeCtx(ws)),
    ).rejects.toThrow(/listCommitChecks/);
  });
});

describe("M10 schema bounds", () => {
  it("review schema requires line >= 1 in comments", () => {
    expect(() =>
      githubReviewPullRequestTool.inputSchema.parse({
        number: 1,
        comments: [{ path: "a.ts", line: 0, body: "x" }],
      }),
    ).toThrow();
  });

  it("github review accepts the three verdict enums", () => {
    for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const) {
      expect(() =>
        githubReviewPullRequestTool.inputSchema.parse({ number: 1, event }),
      ).not.toThrow();
    }
  });

  it("github review rejects unknown event values", () => {
    expect(() =>
      githubReviewPullRequestTool.inputSchema.parse({
        number: 1,
        event: "BOGUS",
      }),
    ).toThrow();
  });

  it("gitlab review schema does NOT accept event field", () => {
    // Zod object() defaults to stripping unknown keys, so the parse
    // succeeds but `event` is dropped — the agent has no way to pass it.
    const parsed = gitlabReviewMergeRequestTool.inputSchema.parse({
      number: 1,
      event: "APPROVE",
    });
    expect("event" in parsed).toBe(false);
  });

  it("commit-checks schemas require non-empty sha", () => {
    expect(() =>
      githubListCommitChecksTool.inputSchema.parse({ sha: "" }),
    ).toThrow();
    expect(() =>
      gitlabListCommitStatusesTool.inputSchema.parse({ sha: "" }),
    ).toThrow();
  });
});
