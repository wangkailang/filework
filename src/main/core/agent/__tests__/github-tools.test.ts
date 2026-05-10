import { describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../workspace/types";
import {
  buildGithubTools,
  githubCommentIssueTool,
  githubCommentPullRequestTool,
  githubGetIssueTool,
  githubGetPullRequestTool,
  githubListIssuesTool,
  githubListPullRequestsTool,
  githubSearchCodeTool,
} from "../tools/github-tools";

const fakeWorkspace = (scm?: Partial<WorkspaceSCM>): Workspace =>
  ({
    id: "github:acme/app@main",
    kind: "github",
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

describe("github tools — registration", () => {
  it("buildGithubTools yields all 7 tools in order", () => {
    const tools = buildGithubTools();
    expect(tools.map((t) => t.name)).toEqual([
      "githubListPullRequests",
      "githubGetPullRequest",
      "githubListIssues",
      "githubGetIssue",
      "githubCommentIssue",
      "githubCommentPullRequest",
      "githubSearchCode",
    ]);
  });

  it("read tools are safe; comment tools are destructive", () => {
    const tools = buildGithubTools();
    const safety = Object.fromEntries(
      tools.map((t) => [t.name, t.safety]),
    ) as Record<string, "safe" | "destructive">;
    expect(safety.githubListPullRequests).toBe("safe");
    expect(safety.githubGetPullRequest).toBe("safe");
    expect(safety.githubListIssues).toBe("safe");
    expect(safety.githubGetIssue).toBe("safe");
    expect(safety.githubSearchCode).toBe("safe");
    expect(safety.githubCommentIssue).toBe("destructive");
    expect(safety.githubCommentPullRequest).toBe("destructive");
  });
});

describe("github read tools — delegation", () => {
  it("githubListPullRequests delegates with args", async () => {
    const listPullRequests = vi.fn(async () => [{ number: 1 }] as never);
    const ws = fakeWorkspace({ listPullRequests });
    const out = await githubListPullRequestsTool.execute(
      { state: "open" },
      fakeCtx(ws),
    );
    expect(listPullRequests).toHaveBeenCalledWith({ state: "open" });
    expect(out).toEqual([{ number: 1 }]);
  });

  it("githubGetPullRequest delegates with number", async () => {
    const getPullRequest = vi.fn(async () => ({ number: 42 }) as never);
    const ws = fakeWorkspace({ getPullRequest });
    await githubGetPullRequestTool.execute({ number: 42 }, fakeCtx(ws));
    expect(getPullRequest).toHaveBeenCalledWith({ number: 42 });
  });

  it("githubListIssues delegates with labels", async () => {
    const listIssues = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listIssues });
    await githubListIssuesTool.execute(
      { state: "open", labels: ["bug"] },
      fakeCtx(ws),
    );
    expect(listIssues).toHaveBeenCalledWith({
      state: "open",
      labels: ["bug"],
    });
  });

  it("githubGetIssue delegates", async () => {
    const getIssue = vi.fn(async () => ({ number: 5 }) as never);
    const ws = fakeWorkspace({ getIssue });
    await githubGetIssueTool.execute({ number: 5 }, fakeCtx(ws));
    expect(getIssue).toHaveBeenCalledWith({ number: 5 });
  });

  it("githubSearchCode delegates with query", async () => {
    const searchCode = vi.fn(
      async () => ({ totalCount: 0, items: [] }) as never,
    );
    const ws = fakeWorkspace({ searchCode });
    await githubSearchCodeTool.execute({ query: "foo" }, fakeCtx(ws));
    expect(searchCode).toHaveBeenCalledWith({ query: "foo" });
  });
});

describe("github comment tools — delegation", () => {
  it("githubCommentIssue delegates with body", async () => {
    const commentIssue = vi.fn(
      async () => ({ commentId: 1, url: "u" }) as never,
    );
    const ws = fakeWorkspace({ commentIssue });
    const out = await githubCommentIssueTool.execute(
      { number: 7, body: "thanks!" },
      fakeCtx(ws),
    );
    expect(commentIssue).toHaveBeenCalledWith({ number: 7, body: "thanks!" });
    expect(out).toEqual({ commentId: 1, url: "u" });
  });

  it("githubCommentPullRequest delegates with body", async () => {
    const commentPullRequest = vi.fn(
      async () => ({ commentId: 2, url: "u" }) as never,
    );
    const ws = fakeWorkspace({ commentPullRequest });
    await githubCommentPullRequestTool.execute(
      { number: 42, body: "looks good" },
      fakeCtx(ws),
    );
    expect(commentPullRequest).toHaveBeenCalledWith({
      number: 42,
      body: "looks good",
    });
  });
});

describe("github tools — schemas", () => {
  it("commentIssue rejects empty body", () => {
    expect(
      githubCommentIssueTool.inputSchema.safeParse({ number: 1, body: "" })
        .success,
    ).toBe(false);
  });

  it("commentIssue rejects non-positive number", () => {
    expect(
      githubCommentIssueTool.inputSchema.safeParse({ number: 0, body: "x" })
        .success,
    ).toBe(false);
  });

  it("searchCode rejects empty query", () => {
    expect(
      githubSearchCodeTool.inputSchema.safeParse({ query: "" }).success,
    ).toBe(false);
  });

  it("listPullRequests accepts state filter", () => {
    expect(
      githubListPullRequestsTool.inputSchema.safeParse({ state: "all" })
        .success,
    ).toBe(true);
  });
});

describe("github tools — error when scm method missing", () => {
  it("throws a friendly error with the method name", async () => {
    const ws = fakeWorkspace({});
    await expect(
      githubListPullRequestsTool.execute({}, fakeCtx(ws)),
    ).rejects.toThrow(/does not support listPullRequests/);
    await expect(
      githubCommentIssueTool.execute({ number: 1, body: "x" }, fakeCtx(ws)),
    ).rejects.toThrow(/does not support commentIssue/);
  });
});
