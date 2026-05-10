/**
 * CI tools (M8) — github + gitlab list/get/jobs delegation + safety + schema.
 *
 * Same fakeWorkspace harness as github-tools.test.ts. Verifies that each
 * tool delegates to the right SCM method, rejects unsupported workspaces,
 * is registered in the build* output, and is `safety: "safe"`.
 */

import { describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../workspace/types";
import {
  buildGithubTools,
  githubGetWorkflowRunTool,
  githubListWorkflowRunJobsTool,
  githubListWorkflowRunsTool,
} from "../tools/github-tools";
import {
  buildGitlabTools,
  gitlabGetPipelineTool,
  gitlabListPipelineJobsTool,
  gitlabListPipelinesTool,
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
  toolCallId: "t-ci",
});

describe("CI tools — registration", () => {
  it("buildGithubTools includes the three CI tools", () => {
    const names = buildGithubTools().map((t) => t.name);
    expect(names).toContain("githubListWorkflowRuns");
    expect(names).toContain("githubGetWorkflowRun");
    expect(names).toContain("githubListWorkflowRunJobs");
  });

  it("buildGitlabTools includes the three CI tools", () => {
    const names = buildGitlabTools().map((t) => t.name);
    expect(names).toContain("gitlabListPipelines");
    expect(names).toContain("gitlabGetPipeline");
    expect(names).toContain("gitlabListPipelineJobs");
  });

  it("all six CI tools are safety:'safe'", () => {
    for (const t of [
      githubListWorkflowRunsTool,
      githubGetWorkflowRunTool,
      githubListWorkflowRunJobsTool,
      gitlabListPipelinesTool,
      gitlabGetPipelineTool,
      gitlabListPipelineJobsTool,
    ]) {
      expect(t.safety).toBe("safe");
    }
  });
});

describe("github CI tools — delegation", () => {
  it("githubListWorkflowRuns forwards args to scm.listCIRuns", async () => {
    const listCIRuns = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listCIRuns });
    await githubListWorkflowRunsTool.execute(
      { ref: "main", status: "completed", limit: 25 },
      fakeCtx(ws),
    );
    expect(listCIRuns).toHaveBeenCalledWith({
      ref: "main",
      status: "completed",
      limit: 25,
    });
  });

  it("githubGetWorkflowRun forwards id to scm.getCIRun", async () => {
    const getCIRun = vi.fn(async () => ({ id: "42" }) as never);
    const ws = fakeWorkspace({ getCIRun });
    await githubGetWorkflowRunTool.execute({ id: "42" }, fakeCtx(ws));
    expect(getCIRun).toHaveBeenCalledWith({ id: "42" });
  });

  it("githubListWorkflowRunJobs forwards runId to scm.listCIJobs", async () => {
    const listCIJobs = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listCIJobs });
    await githubListWorkflowRunJobsTool.execute({ runId: "42" }, fakeCtx(ws));
    expect(listCIJobs).toHaveBeenCalledWith({ runId: "42" });
  });

  it("throws when the workspace does not implement listCIRuns", async () => {
    const ws = fakeWorkspace({});
    await expect(
      githubListWorkflowRunsTool.execute({}, fakeCtx(ws)),
    ).rejects.toThrow(/listCIRuns/);
  });
});

describe("gitlab CI tools — delegation", () => {
  it("gitlabListPipelines forwards args to scm.listCIRuns", async () => {
    const listCIRuns = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listCIRuns });
    await gitlabListPipelinesTool.execute(
      { ref: "feat/x", status: "in_progress", limit: 50 },
      fakeCtx(ws),
    );
    expect(listCIRuns).toHaveBeenCalledWith({
      ref: "feat/x",
      status: "in_progress",
      limit: 50,
    });
  });

  it("gitlabGetPipeline forwards id to scm.getCIRun", async () => {
    const getCIRun = vi.fn(async () => ({ id: "7" }) as never);
    const ws = fakeWorkspace({ getCIRun });
    await gitlabGetPipelineTool.execute({ id: "7" }, fakeCtx(ws));
    expect(getCIRun).toHaveBeenCalledWith({ id: "7" });
  });

  it("gitlabListPipelineJobs forwards runId to scm.listCIJobs", async () => {
    const listCIJobs = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listCIJobs });
    await gitlabListPipelineJobsTool.execute({ runId: "7" }, fakeCtx(ws));
    expect(listCIJobs).toHaveBeenCalledWith({ runId: "7" });
  });
});

describe("CI tool input schemas", () => {
  it("listWorkflowRuns rejects limit > 100", () => {
    expect(() =>
      githubListWorkflowRunsTool.inputSchema.parse({ limit: 500 }),
    ).toThrow();
  });

  it("getWorkflowRun requires non-empty id", () => {
    expect(() =>
      githubGetWorkflowRunTool.inputSchema.parse({ id: "" }),
    ).toThrow();
  });

  it("listPipelineJobs requires non-empty runId", () => {
    expect(() =>
      gitlabListPipelineJobsTool.inputSchema.parse({ runId: "" }),
    ).toThrow();
  });
});
