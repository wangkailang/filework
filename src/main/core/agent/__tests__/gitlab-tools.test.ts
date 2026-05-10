import { describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../workspace/types";
import {
  buildGitlabTools,
  gitlabCommentIssueTool,
  gitlabCommentMergeRequestTool,
  gitlabGetIssueTool,
  gitlabGetMergeRequestTool,
  gitlabListIssuesTool,
  gitlabListMergeRequestsTool,
  gitlabSearchCodeTool,
} from "../tools/gitlab-tools";

const fakeWorkspace = (scm?: Partial<WorkspaceSCM>): Workspace =>
  ({
    id: "gitlab:gitlab.com:acme/app@main",
    kind: "gitlab",
    root: "/tmp/clone",
    fs: {} as never,
    exec: {} as never,
    scm: scm as WorkspaceSCM | undefined,
  }) as Workspace;

const fakeCtx = (workspace: Workspace) => ({
  workspace,
  signal: new AbortController().signal,
  toolCallId: "t-1",
});

describe("gitlab tools — registration", () => {
  it("buildGitlabTools yields all 7 tools in order", () => {
    expect(buildGitlabTools().map((t) => t.name)).toEqual([
      "gitlabListMergeRequests",
      "gitlabGetMergeRequest",
      "gitlabListIssues",
      "gitlabGetIssue",
      "gitlabCommentIssue",
      "gitlabCommentMergeRequest",
      "gitlabSearchCode",
    ]);
  });

  it("read tools are safe; comment tools are destructive", () => {
    const safety = Object.fromEntries(
      buildGitlabTools().map((t) => [t.name, t.safety]),
    ) as Record<string, "safe" | "destructive">;
    expect(safety.gitlabListMergeRequests).toBe("safe");
    expect(safety.gitlabGetMergeRequest).toBe("safe");
    expect(safety.gitlabListIssues).toBe("safe");
    expect(safety.gitlabGetIssue).toBe("safe");
    expect(safety.gitlabSearchCode).toBe("safe");
    expect(safety.gitlabCommentIssue).toBe("destructive");
    expect(safety.gitlabCommentMergeRequest).toBe("destructive");
  });
});

describe("gitlab read tools — delegation", () => {
  it("gitlabListMergeRequests delegates to listPullRequests", async () => {
    const listPullRequests = vi.fn(async () => [{ number: 1 }] as never);
    const ws = fakeWorkspace({ listPullRequests });
    await gitlabListMergeRequestsTool.execute({ state: "open" }, fakeCtx(ws));
    expect(listPullRequests).toHaveBeenCalledWith({ state: "open" });
  });

  it("gitlabGetMergeRequest delegates to getPullRequest", async () => {
    const getPullRequest = vi.fn(async () => ({ number: 42 }) as never);
    const ws = fakeWorkspace({ getPullRequest });
    await gitlabGetMergeRequestTool.execute({ number: 42 }, fakeCtx(ws));
    expect(getPullRequest).toHaveBeenCalledWith({ number: 42 });
  });

  it("gitlabListIssues delegates to listIssues", async () => {
    const listIssues = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listIssues });
    await gitlabListIssuesTool.execute(
      { state: "open", labels: ["bug"] },
      fakeCtx(ws),
    );
    expect(listIssues).toHaveBeenCalledWith({
      state: "open",
      labels: ["bug"],
    });
  });

  it("gitlabGetIssue delegates", async () => {
    const getIssue = vi.fn(async () => ({ number: 5 }) as never);
    const ws = fakeWorkspace({ getIssue });
    await gitlabGetIssueTool.execute({ number: 5 }, fakeCtx(ws));
    expect(getIssue).toHaveBeenCalledWith({ number: 5 });
  });

  it("gitlabSearchCode delegates with query", async () => {
    const searchCode = vi.fn(
      async () => ({ totalCount: 0, items: [] }) as never,
    );
    const ws = fakeWorkspace({ searchCode });
    await gitlabSearchCodeTool.execute({ query: "foo" }, fakeCtx(ws));
    expect(searchCode).toHaveBeenCalledWith({ query: "foo" });
  });
});

describe("gitlab comment tools — delegation", () => {
  it("gitlabCommentIssue delegates to commentIssue", async () => {
    const commentIssue = vi.fn(
      async () => ({ commentId: 1, url: "u" }) as never,
    );
    const ws = fakeWorkspace({ commentIssue });
    await gitlabCommentIssueTool.execute(
      { number: 7, body: "thanks!" },
      fakeCtx(ws),
    );
    expect(commentIssue).toHaveBeenCalledWith({ number: 7, body: "thanks!" });
  });

  it("gitlabCommentMergeRequest delegates to commentPullRequest", async () => {
    const commentPullRequest = vi.fn(
      async () => ({ commentId: 2, url: "u" }) as never,
    );
    const ws = fakeWorkspace({ commentPullRequest });
    await gitlabCommentMergeRequestTool.execute(
      { number: 42, body: "looks good" },
      fakeCtx(ws),
    );
    expect(commentPullRequest).toHaveBeenCalledWith({
      number: 42,
      body: "looks good",
    });
  });
});

describe("gitlab tools — schemas", () => {
  it("commentIssue rejects empty body", () => {
    expect(
      gitlabCommentIssueTool.inputSchema.safeParse({ number: 1, body: "" })
        .success,
    ).toBe(false);
  });

  it("commentMergeRequest rejects non-positive number", () => {
    expect(
      gitlabCommentMergeRequestTool.inputSchema.safeParse({
        number: 0,
        body: "x",
      }).success,
    ).toBe(false);
  });

  it("searchCode rejects empty query", () => {
    expect(
      gitlabSearchCodeTool.inputSchema.safeParse({ query: "" }).success,
    ).toBe(false);
  });
});

describe("gitlab tools — error when scm method missing", () => {
  it("throws a friendly error with the method name", async () => {
    const ws = fakeWorkspace({});
    await expect(
      gitlabListMergeRequestsTool.execute({}, fakeCtx(ws)),
    ).rejects.toThrow(/does not support listPullRequests/);
    await expect(
      gitlabCommentIssueTool.execute({ number: 1, body: "x" }, fakeCtx(ws)),
    ).rejects.toThrow(/does not support commentIssue/);
  });
});
