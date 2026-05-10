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

const mkWorkspace = (kind: "local" | "github"): Workspace =>
  ({
    id: kind === "local" ? "local:/tmp/ws" : "github:acme/app@main",
    kind,
    root: "/tmp/ws",
    fs: {} as never,
    exec: {} as never,
    scm: kind === "github" ? ({} as never) : undefined,
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
});
