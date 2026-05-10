import { describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../workspace/types";
import {
  buildGitTools,
  gitCommitTool,
  gitPushTool,
  openPullRequestTool,
} from "../tools/git-tools";

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

describe("git tools — registration", () => {
  it("buildGitTools yields commit / push / openPullRequest in order", () => {
    const tools = buildGitTools();
    expect(tools.map((t) => t.name)).toEqual([
      "gitCommit",
      "gitPush",
      "openPullRequest",
    ]);
    expect(tools.every((t) => t.safety === "destructive")).toBe(true);
  });
});

describe("gitCommitTool", () => {
  it("delegates to workspace.scm.commit with args", async () => {
    const commit = vi.fn(async () => ({
      sha: "abc",
      branch: "claude/x",
      filesChanged: 1,
    }));
    const ws = fakeWorkspace({ commit });
    const out = await gitCommitTool.execute(
      { message: "feat: x", files: ["a.ts"] },
      fakeCtx(ws),
    );
    expect(commit).toHaveBeenCalledWith({
      message: "feat: x",
      files: ["a.ts"],
    });
    expect(out).toEqual({ sha: "abc", branch: "claude/x", filesChanged: 1 });
  });

  it("throws when scm.commit is not implemented", async () => {
    const ws = fakeWorkspace({});
    await expect(
      gitCommitTool.execute({ message: "x" }, fakeCtx(ws)),
    ).rejects.toThrow(/does not support gitCommit/);
  });

  it("schema rejects an empty message", () => {
    const result = gitCommitTool.inputSchema.safeParse({ message: "" });
    expect(result.success).toBe(false);
  });
});

describe("gitPushTool", () => {
  it("delegates to workspace.scm.push", async () => {
    const push = vi.fn(async () => ({ branch: "claude/x", remote: "origin" }));
    const ws = fakeWorkspace({ push });
    const out = await gitPushTool.execute({ force: true }, fakeCtx(ws));
    expect(push).toHaveBeenCalledWith({ force: true });
    expect(out).toEqual({ branch: "claude/x", remote: "origin" });
  });

  it("throws when scm.push is not implemented", async () => {
    const ws = fakeWorkspace({});
    await expect(gitPushTool.execute({}, fakeCtx(ws))).rejects.toThrow(
      /does not support gitPush/,
    );
  });
});

describe("openPullRequestTool", () => {
  it("delegates to workspace.scm.openPullRequest", async () => {
    const openPullRequest = vi.fn(async () => ({
      url: "https://gh/pr/1",
      number: 1,
    }));
    const ws = fakeWorkspace({ openPullRequest });
    const out = await openPullRequestTool.execute(
      { title: "T", body: "B", draft: true },
      fakeCtx(ws),
    );
    expect(openPullRequest).toHaveBeenCalledWith({
      title: "T",
      body: "B",
      draft: true,
    });
    expect(out).toEqual({ url: "https://gh/pr/1", number: 1 });
  });

  it("schema rejects an empty title", () => {
    const result = openPullRequestTool.inputSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("throws when scm.openPullRequest is not implemented", async () => {
    const ws = fakeWorkspace({});
    await expect(
      openPullRequestTool.execute({ title: "x" }, fakeCtx(ws)),
    ).rejects.toThrow(/does not support openPullRequest/);
  });
});
