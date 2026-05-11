/**
 * agent-tools.ts × CiWatcher integration (M12).
 *
 * Verifies the rerun tools' execute fns are wrapped to call
 * ciWatcher.subscribe after success, and that non-wrapped tools
 * (listWorkflowRuns, dispatchWorkflow) do NOT trigger a subscribe.
 */

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace, WorkspaceSCM } from "../../core/workspace/types";
import { buildAgentToolRegistry } from "../agent-tools";
import { ciWatcher } from "../ci-watcher";

const fakeSender = (() => ({
  isDestroyed: () => false,
  send: vi.fn(),
})) as unknown as () => WebContents;

const buildWs = (
  scm: Partial<WorkspaceSCM>,
  kind: "github" | "gitlab" = "github",
): Workspace =>
  ({
    id: kind === "github" ? "github:acme/app@main" : "gitlab:gl/x/y@main",
    kind,
    root: "/tmp/x",
    fs: {} as never,
    exec: {} as never,
    scm: scm as WorkspaceSCM,
  }) as Workspace;

describe("agent-tools × ci-watcher integration", () => {
  let subscribeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    subscribeSpy = vi
      .spyOn(ciWatcher, "subscribe")
      .mockReturnValue("github:acme/app@main:42");
  });

  afterEach(() => {
    subscribeSpy.mockRestore();
  });

  it("githubRerunFailedJobs subscribes to the watcher after success", async () => {
    const sender = fakeSender();
    const taskId = "t-rerun-1";
    const rerunCI = vi.fn(async () => ({ runId: "42", queued: true }));
    const ws = buildWs({ rerunCI });

    const registry = buildAgentToolRegistry({ sender, taskId, workspace: ws });
    const tools = registry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace: ws,
        signal: new AbortController().signal,
        toolCallId,
      }),
    });
    const tool = tools.githubRerunFailedJobs;
    expect(tool).toBeDefined();
    if (!tool?.execute) throw new Error("tool not registered");

    const ctrl = new AbortController();
    await tool.execute(
      { runId: "42" },
      {
        toolCallId: "tc-1",
        messages: [],
        abortSignal: ctrl.signal,
      },
    );

    expect(rerunCI).toHaveBeenCalledWith({ runId: "42", failedOnly: true });
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    const callArg = subscribeSpy.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      runId: "42",
      sender,
      taskId,
    });
    expect((callArg as { workspace: Workspace }).workspace).toBe(ws);
    expect((callArg as { signal: AbortSignal }).signal).toBeDefined();
  });

  it("githubRerunWorkflowRun (full re-run) also subscribes", async () => {
    const sender = fakeSender();
    const rerunCI = vi.fn(async () => ({ runId: "99", queued: true }));
    const ws = buildWs({ rerunCI });
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "t-2",
      workspace: ws,
    });
    const tools = registry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace: ws,
        signal: new AbortController().signal,
        toolCallId,
      }),
    });
    const tool = tools.githubRerunWorkflowRun;
    if (!tool?.execute) throw new Error("tool not registered");
    await tool.execute(
      { runId: "99" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined as never },
    );
    expect(rerunCI).toHaveBeenCalledWith({ runId: "99", failedOnly: false });
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy.mock.calls[0]?.[0]).toMatchObject({ runId: "99" });
  });

  it("gitlabRetryPipeline subscribes", async () => {
    const sender = fakeSender();
    const rerunCI = vi.fn(async () => ({ runId: "7", queued: true }));
    const ws = buildWs({ rerunCI }, "gitlab");
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "t-3",
      workspace: ws,
    });
    const tools = registry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace: ws,
        signal: new AbortController().signal,
        toolCallId,
      }),
    });
    const tool = tools.gitlabRetryPipeline;
    if (!tool?.execute) throw new Error("tool not registered");
    await tool.execute(
      { runId: "7" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined as never },
    );
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy.mock.calls[0]?.[0]).toMatchObject({ runId: "7" });
  });

  it("githubDispatchWorkflow does NOT subscribe (deferred)", async () => {
    const sender = fakeSender();
    const dispatchWorkflow = vi.fn(async () => ({
      workflowFile: "ci.yml",
      ref: "main",
      queued: true,
    }));
    const ws = buildWs({ dispatchWorkflow });
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "t-4",
      workspace: ws,
    });
    const tools = registry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace: ws,
        signal: new AbortController().signal,
        toolCallId,
      }),
    });
    const tool = tools.githubDispatchWorkflow;
    if (!tool?.execute) throw new Error("tool not registered");
    await tool.execute(
      { workflowFile: "ci.yml", ref: "main" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined as never },
    );
    expect(dispatchWorkflow).toHaveBeenCalled();
    // Dispatch returns no runId — wrapper guard skips subscribe.
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("safe tools (listWorkflowRuns) do NOT subscribe", async () => {
    const sender = fakeSender();
    const listCIRuns = vi.fn(async () => []);
    const ws = buildWs({ listCIRuns });
    const registry = buildAgentToolRegistry({
      sender,
      taskId: "t-5",
      workspace: ws,
    });
    const tools = registry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace: ws,
        signal: new AbortController().signal,
        toolCallId,
      }),
    });
    const tool = tools.githubListWorkflowRuns;
    if (!tool?.execute) throw new Error("tool not registered");
    await tool.execute(
      {},
      { toolCallId: "tc-1", messages: [], abortSignal: undefined as never },
    );
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});
