/**
 * CI write tools (M11) — cancel + listWorkflows + dispatchWorkflow.
 *
 * Same fakeWorkspace harness as ci-tools.test.ts / pr-review-tools.test.ts.
 * Verifies registration, safety, schema bounds, and delegation.
 */

import { describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../workspace/types";
import {
  buildGithubTools,
  githubCancelWorkflowRunTool,
  githubDispatchWorkflowTool,
  githubListWorkflowsTool,
} from "../tools/github-tools";
import {
  buildGitlabTools,
  gitlabCancelPipelineTool,
  gitlabCreatePipelineTool,
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
  toolCallId: "t-w",
});

describe("M11 CI write tools — registration", () => {
  it("buildGithubTools exposes cancel + listWorkflows + dispatch", () => {
    const names = buildGithubTools().map((t) => t.name);
    expect(names).toContain("githubCancelWorkflowRun");
    expect(names).toContain("githubListWorkflows");
    expect(names).toContain("githubDispatchWorkflow");
  });

  it("buildGitlabTools exposes cancelPipeline + createPipeline", () => {
    const names = buildGitlabTools().map((t) => t.name);
    expect(names).toContain("gitlabCancelPipeline");
    expect(names).toContain("gitlabCreatePipeline");
  });

  it("safety classifications", () => {
    expect(githubCancelWorkflowRunTool.safety).toBe("destructive");
    expect(githubDispatchWorkflowTool.safety).toBe("destructive");
    expect(gitlabCancelPipelineTool.safety).toBe("destructive");
    expect(gitlabCreatePipelineTool.safety).toBe("destructive");
    expect(githubListWorkflowsTool.safety).toBe("safe");
  });
});

describe("M11 CI write tools — delegation", () => {
  it("githubCancelWorkflowRun delegates to scm.cancelCI", async () => {
    const cancelCI = vi.fn(
      async () => ({ runId: "42", cancelled: true }) as never,
    );
    const ws = fakeWorkspace({ cancelCI });
    await githubCancelWorkflowRunTool.execute({ runId: "42" }, fakeCtx(ws));
    expect(cancelCI).toHaveBeenCalledWith({ runId: "42" });
  });

  it("gitlabCancelPipeline delegates to scm.cancelCI", async () => {
    const cancelCI = vi.fn(
      async () => ({ runId: "9", cancelled: true }) as never,
    );
    const ws = fakeWorkspace({ cancelCI });
    await gitlabCancelPipelineTool.execute({ runId: "9" }, fakeCtx(ws));
    expect(cancelCI).toHaveBeenCalledWith({ runId: "9" });
  });

  it("githubListWorkflows delegates to scm.listWorkflows with no args", async () => {
    const listWorkflows = vi.fn(async () => [] as never);
    const ws = fakeWorkspace({ listWorkflows });
    await githubListWorkflowsTool.execute({}, fakeCtx(ws));
    expect(listWorkflows).toHaveBeenCalledWith();
  });

  it("githubDispatchWorkflow forwards full payload to scm.dispatchWorkflow", async () => {
    const dispatchWorkflow = vi.fn(
      async () =>
        ({ workflowFile: "ci.yml", ref: "main", queued: true }) as never,
    );
    const ws = fakeWorkspace({ dispatchWorkflow });
    await githubDispatchWorkflowTool.execute(
      {
        workflowFile: "ci.yml",
        ref: "main",
        inputs: { env: "staging" },
      },
      fakeCtx(ws),
    );
    expect(dispatchWorkflow).toHaveBeenCalledWith({
      workflowFile: "ci.yml",
      ref: "main",
      inputs: { env: "staging" },
    });
  });

  it("throws a friendly error when scm.cancelCI is missing", async () => {
    const ws = fakeWorkspace({});
    await expect(
      githubCancelWorkflowRunTool.execute({ runId: "42" }, fakeCtx(ws)),
    ).rejects.toThrow(/cancelCI/);
  });

  it("throws when scm.listWorkflows is missing", async () => {
    const ws = fakeWorkspace({});
    await expect(
      githubListWorkflowsTool.execute({}, fakeCtx(ws)),
    ).rejects.toThrow(/listWorkflows/);
  });
});

describe("M11 CI write tools — schema bounds", () => {
  it("cancel schemas require non-empty runId", () => {
    expect(() =>
      githubCancelWorkflowRunTool.inputSchema.parse({ runId: "" }),
    ).toThrow();
    expect(() =>
      gitlabCancelPipelineTool.inputSchema.parse({ runId: "" }),
    ).toThrow();
  });

  it("dispatch requires non-empty workflowFile and ref", () => {
    expect(() =>
      githubDispatchWorkflowTool.inputSchema.parse({
        workflowFile: "",
        ref: "main",
      }),
    ).toThrow();
    expect(() =>
      githubDispatchWorkflowTool.inputSchema.parse({
        workflowFile: "ci.yml",
        ref: "",
      }),
    ).toThrow();
  });

  it("dispatch accepts string-valued inputs record", () => {
    expect(() =>
      githubDispatchWorkflowTool.inputSchema.parse({
        workflowFile: "ci.yml",
        ref: "main",
        inputs: { env: "staging", verbose: "true" },
      }),
    ).not.toThrow();
  });

  it("listWorkflows takes an empty object", () => {
    expect(githubListWorkflowsTool.inputSchema.parse({})).toEqual({});
  });

  it("createPipeline requires non-empty ref", () => {
    expect(() =>
      gitlabCreatePipelineTool.inputSchema.parse({ ref: "" }),
    ).toThrow();
  });

  it("createPipeline accepts string-valued variables record", () => {
    expect(() =>
      gitlabCreatePipelineTool.inputSchema.parse({
        ref: "main",
        variables: { ENV: "staging" },
      }),
    ).not.toThrow();
  });
});

describe("M14 createPipeline tool — delegation", () => {
  it("gitlabCreatePipeline forwards full payload to scm.createCIPipeline", async () => {
    const createCIPipeline = vi.fn(
      async () => ({ runId: "42", queued: true, ref: "main" }) as never,
    );
    const ws = fakeWorkspace({ createCIPipeline });
    await gitlabCreatePipelineTool.execute(
      { ref: "main", variables: { ENV: "staging" } },
      fakeCtx(ws),
    );
    expect(createCIPipeline).toHaveBeenCalledWith({
      ref: "main",
      variables: { ENV: "staging" },
    });
  });

  it("throws when scm.createCIPipeline is missing", async () => {
    const ws = fakeWorkspace({});
    await expect(
      gitlabCreatePipelineTool.execute({ ref: "main" }, fakeCtx(ws)),
    ).rejects.toThrow(/createCIPipeline/);
  });
});
