import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/incremental-scanner", () => ({
  getIncrementalScanner: () => ({
    scanIncremental: async () => ({
      totalFiles: 0,
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
      scanTime: 0,
    }),
    getCacheStats: () => ({ directories: 0, totalFiles: 0, memoryUsage: 0 }),
    clearCache: async () => {},
  }),
  FileEntry: {},
}));

import type { Workspace } from "../../core/workspace/types";
import { buildAgentToolRegistry } from "../agent-tools";

const fakeSender = {
  isDestroyed: () => false,
  send: () => {},
} as unknown as Electron.WebContents;

const mkWorkspace = (kind: "local" | "github" | "gitlab"): Workspace =>
  ({
    id:
      kind === "local"
        ? "local:/tmp/ws"
        : kind === "github"
          ? "github:acme/app@main"
          : "gitlab:gitlab.com:acme/app@main",
    kind,
    root: "/tmp/ws",
    fs: {} as never,
    exec: {} as never,
    scm: kind !== "local" ? ({} as never) : undefined,
  }) as Workspace;

describe("buildAgentToolRegistry — git-tool registration", () => {
  it("registers gitCommit/gitPush/openPullRequest for github workspaces", () => {
    const registry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    expect(registry.has("gitCommit")).toBe(true);
    expect(registry.has("gitPush")).toBe(true);
    expect(registry.has("openPullRequest")).toBe(true);
  });

  it("does NOT register git tools for local workspaces", () => {
    const registry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    expect(registry.has("gitCommit")).toBe(false);
    expect(registry.has("gitPush")).toBe(false);
    expect(registry.has("openPullRequest")).toBe(false);
  });

  it("file tools register for both workspace kinds", () => {
    for (const kind of ["local", "github"] as const) {
      const registry = buildAgentToolRegistry({
        sender: fakeSender,
        taskId: "t-1",
        workspace: mkWorkspace(kind),
      });
      expect(registry.has("readFile")).toBe(true);
      expect(registry.has("writeFile")).toBe(true);
      expect(registry.has("askClarification")).toBe(true);
    }
  });

  it("respects allowedTools — gitPush dropped when not in the allow-list", () => {
    const registry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
      allowedTools: ["gitCommit", "readFile"],
    });
    expect(registry.has("gitCommit")).toBe(true);
    expect(registry.has("readFile")).toBe(true);
    expect(registry.has("gitPush")).toBe(false);
    expect(registry.has("openPullRequest")).toBe(false);
  });

  it("registers all 7 github query/comment tools for github workspaces", () => {
    const registry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of [
      "githubListPullRequests",
      "githubGetPullRequest",
      "githubListIssues",
      "githubGetIssue",
      "githubCommentIssue",
      "githubCommentPullRequest",
      "githubSearchCode",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("does NOT register github query/comment tools for local workspaces", () => {
    const registry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of [
      "githubListPullRequests",
      "githubGetPullRequest",
      "githubListIssues",
      "githubGetIssue",
      "githubCommentIssue",
      "githubCommentPullRequest",
      "githubSearchCode",
    ]) {
      expect(registry.has(name)).toBe(false);
    }
  });

  it("registers all 7 gitlab tools for gitlab workspaces, not on github/local", () => {
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    for (const name of [
      "gitlabListMergeRequests",
      "gitlabGetMergeRequest",
      "gitlabListIssues",
      "gitlabGetIssue",
      "gitlabCommentIssue",
      "gitlabCommentMergeRequest",
      "gitlabSearchCode",
    ]) {
      expect(gitlabRegistry.has(name)).toBe(true);
    }

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    expect(githubRegistry.has("gitlabListMergeRequests")).toBe(false);
    expect(githubRegistry.has("gitlabCommentIssue")).toBe(false);

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    expect(localRegistry.has("gitlabListMergeRequests")).toBe(false);
  });

  it("gitlab workspace also gets the shared gitCommit/gitPush/openPullRequest tools", () => {
    const registry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    expect(registry.has("gitCommit")).toBe(true);
    expect(registry.has("gitPush")).toBe(true);
    expect(registry.has("openPullRequest")).toBe(true);
  });

  it("registers github CI tools on github only (M8)", () => {
    const ciTools = [
      "githubListWorkflowRuns",
      "githubGetWorkflowRun",
      "githubListWorkflowRunJobs",
    ];
    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of ciTools) {
      expect(githubRegistry.has(name)).toBe(true);
    }

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of ciTools) {
      expect(localRegistry.has(name)).toBe(false);
    }
  });

  it("registers gitlab CI tools on gitlab only (M8)", () => {
    const ciTools = [
      "gitlabListPipelines",
      "gitlabGetPipeline",
      "gitlabListPipelineJobs",
    ];
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    for (const name of ciTools) {
      expect(gitlabRegistry.has(name)).toBe(true);
    }

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of ciTools) {
      expect(githubRegistry.has(name)).toBe(false);
    }
  });

  it("registers github log + rerun tools on github only (M9)", () => {
    const m9Tools = [
      "githubGetWorkflowJobLog",
      "githubRerunWorkflowRun",
      "githubRerunFailedJobs",
    ];
    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m9Tools) {
      expect(githubRegistry.has(name)).toBe(true);
    }

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of m9Tools) {
      expect(localRegistry.has(name)).toBe(false);
    }
  });

  it("registers gitlab log + retry tools on gitlab only (M9)", () => {
    const m9Tools = ["gitlabGetJobLog", "gitlabRetryPipeline"];
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    for (const name of m9Tools) {
      expect(gitlabRegistry.has(name)).toBe(true);
    }

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m9Tools) {
      expect(githubRegistry.has(name)).toBe(false);
    }
  });

  it("registers github review + check-runs tools on github only (M10)", () => {
    const m10Tools = ["githubReviewPullRequest", "githubListCommitChecks"];
    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m10Tools) {
      expect(githubRegistry.has(name)).toBe(true);
    }

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of m10Tools) {
      expect(localRegistry.has(name)).toBe(false);
    }
  });

  it("registers gitlab review + statuses tools on gitlab only (M10)", () => {
    const m10Tools = ["gitlabReviewMergeRequest", "gitlabListCommitStatuses"];
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    for (const name of m10Tools) {
      expect(gitlabRegistry.has(name)).toBe(true);
    }

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m10Tools) {
      expect(githubRegistry.has(name)).toBe(false);
    }
  });

  it("registers github cancel + listWorkflows + dispatch on github only (M11)", () => {
    const m11Tools = [
      "githubCancelWorkflowRun",
      "githubListWorkflows",
      "githubDispatchWorkflow",
    ];
    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m11Tools) {
      expect(githubRegistry.has(name)).toBe(true);
    }

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of m11Tools) {
      expect(localRegistry.has(name)).toBe(false);
    }
  });

  it("registers gitlab cancel on gitlab only (M11)", () => {
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    expect(gitlabRegistry.has("gitlabCancelPipeline")).toBe(true);

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    expect(githubRegistry.has("gitlabCancelPipeline")).toBe(false);
  });

  it("registers gitlab createPipeline on gitlab only (M14)", () => {
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    expect(gitlabRegistry.has("gitlabCreatePipeline")).toBe(true);

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    expect(githubRegistry.has("gitlabCreatePipeline")).toBe(false);

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    expect(localRegistry.has("gitlabCreatePipeline")).toBe(false);
  });

  it("registers github review lifecycle tools on github only (M15)", () => {
    const m15Tools = ["githubDismissReview", "githubEditReviewBody"];
    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m15Tools) {
      expect(githubRegistry.has(name)).toBe(true);
    }

    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    for (const name of m15Tools) {
      expect(gitlabRegistry.has(name)).toBe(false);
    }

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of m15Tools) {
      expect(localRegistry.has(name)).toBe(false);
    }
  });

  it("registers gitlab MR approve / unapprove / listApprovalRules on gitlab only (M16)", () => {
    const m16Tools = [
      "gitlabApproveMergeRequest",
      "gitlabUnapproveMergeRequest",
      "gitlabListMergeRequestApprovalRules",
    ];
    const gitlabRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("gitlab"),
    });
    for (const name of m16Tools) {
      expect(gitlabRegistry.has(name)).toBe(true);
    }

    const githubRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("github"),
    });
    for (const name of m16Tools) {
      expect(githubRegistry.has(name)).toBe(false);
    }

    const localRegistry = buildAgentToolRegistry({
      sender: fakeSender,
      taskId: "t-1",
      workspace: mkWorkspace("local"),
    });
    for (const name of m16Tools) {
      expect(localRegistry.has(name)).toBe(false);
    }
  });
});
