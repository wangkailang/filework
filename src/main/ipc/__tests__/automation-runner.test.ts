import { describe, expect, it, vi } from "vitest";

import type { AutomationRunRecord } from "../../db";
import {
  prepareAutomationExecutionWorkspace,
  runAutomationHeadless,
} from "../automation-runner";

const automation = {
  id: "auto-1",
  title: "Daily repo check",
  prompt: "Check repo",
  type: "project" as const,
  scheduleKind: "daily" as const,
  scheduleValue: "09:00",
  enabled: true,
  threadId: null,
  workspacePaths: ["/workspace"],
  runMode: "local" as const,
  modelId: null,
  reasoningEffort: null,
  lastRunAt: null,
  nextRunAt: "2026-06-18T09:00:00.000Z",
  createdAt: "2026-06-18T08:00:00.000Z",
  updatedAt: "2026-06-18T08:00:00.000Z",
};

const run = {
  id: "run-1",
  automationId: "auto-1",
  automationTitle: "Daily repo check",
  trigger: "manual" as const,
  status: "queued" as const,
  triageStatus: "open" as const,
  needsActionReason: null,
  chatSessionId: null,
  assistantMessageId: null,
  taskId: null,
  prompt: "Check repo",
  workspacePaths: ["/workspace"],
  threadId: null,
  modelId: null,
  output: null,
  errorMessage: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  retryCount: 0,
  maxAttempts: 3,
  nextRetryAt: null,
  createdAt: "2026-06-18T09:00:00.000Z",
  updatedAt: "2026-06-18T09:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

async function* completedAgentRun() {
  yield {
    type: "message_update" as const,
    agentId: "run-1",
    messageId: "m1",
    deltaText: "Repo is clean.",
  };
  yield {
    type: "agent_end" as const,
    agentId: "run-1",
    status: "completed" as const,
    finalText: "Repo is clean.",
    totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  };
}

describe("automation headless runner", () => {
  it("starts a queued run and stores the agent result", async () => {
    const startAutomationRun = vi.fn(() => ({
      ...run,
      status: "running" as const,
    }));
    const finishAutomationRun = vi.fn((id, updates) => ({
      ...run,
      id,
      ...updates,
    }));

    await runAutomationHeadless(run, automation, {
      startAutomationRun,
      finishAutomationRun,
      runAgent: () => completedAgentRun(),
    });

    expect(startAutomationRun).toHaveBeenCalledWith("run-1");
    expect(finishAutomationRun).toHaveBeenCalledWith("run-1", {
      status: "succeeded",
      output: "Repo is clean.",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
  });

  it("records replayable run events while consuming headless output", async () => {
    const startAutomationRun = vi.fn(() => ({
      ...run,
      status: "running" as const,
    }));
    const finishAutomationRun = vi.fn((id, updates) => ({
      ...run,
      id,
      ...updates,
    }));
    const recordAutomationRunEvent = vi.fn();

    await runAutomationHeadless(run, automation, {
      startAutomationRun,
      finishAutomationRun,
      recordAutomationRunEvent,
      runAgent: () => completedAgentRun(),
    });

    expect(recordAutomationRunEvent).toHaveBeenCalledWith("run-1", {
      message: "Repo is clean.",
      type: "message_update",
    });
    expect(recordAutomationRunEvent).toHaveBeenCalledWith("run-1", {
      detail: expect.objectContaining({
        status: "completed",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      }),
      message: "Repo is clean.",
      type: "agent_end",
    });
  });

  it("executes project automations once for each workspace path", async () => {
    const multiWorkspaceRun = {
      ...run,
      workspacePaths: ["/workspace-a", "/workspace-b"],
    };
    const startAutomationRun = vi.fn(() => ({
      ...multiWorkspaceRun,
      status: "running" as const,
    }));
    const finishAutomationRun = vi.fn((id, updates) => ({
      ...multiWorkspaceRun,
      id,
      ...updates,
    }));
    const runAgent = vi.fn(async function* (scopedRun: AutomationRunRecord) {
      const workspacePath = scopedRun.workspacePaths?.[0] ?? "";
      yield {
        type: "agent_end" as const,
        agentId: scopedRun.id,
        status: "completed" as const,
        finalText: `Summary for ${workspacePath}`,
        totalUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    });

    await runAutomationHeadless(multiWorkspaceRun, automation, {
      startAutomationRun,
      finishAutomationRun,
      runAgent,
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(
      runAgent.mock.calls.map(([scopedRun]) => scopedRun.workspacePaths),
    ).toEqual([["/workspace-a"], ["/workspace-b"]]);
    expect(finishAutomationRun).toHaveBeenCalledWith("run-1", {
      status: "succeeded",
      output:
        "### /workspace-a\n\nSummary for /workspace-a\n\n### /workspace-b\n\nSummary for /workspace-b",
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    });
  });

  it("stores denied tool calls as needs-action runs", async () => {
    const startAutomationRun = vi.fn(() => ({
      ...run,
      status: "running" as const,
    }));
    const finishAutomationRun = vi.fn((id, updates) => ({
      ...run,
      id,
      ...updates,
    }));

    async function* needsActionAgentRun() {
      yield {
        type: "tool_execution_end" as const,
        agentId: "run-1",
        toolCallId: "tool-1",
        toolName: "runCommand",
        result: {
          success: false,
          denied: true,
          reason: "无头自动化不允许提权命令;请在 Triage 中手动处理。",
        },
        success: false,
        durationMs: 0,
      };
      yield {
        type: "agent_end" as const,
        agentId: "run-1",
        status: "completed" as const,
        finalText: "需要人工批准后继续。",
        totalUsage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      };
    }

    await runAutomationHeadless(run, automation, {
      startAutomationRun,
      finishAutomationRun,
      runAgent: () => needsActionAgentRun(),
    });

    expect(finishAutomationRun).toHaveBeenCalledWith("run-1", {
      status: "needs_action",
      output: "需要人工批准后继续。",
      errorMessage: "无头自动化不允许提权命令;请在 Triage 中手动处理。",
      needsActionReason: "无头自动化不允许提权命令;请在 Triage 中手动处理。",
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    });
  });

  it("does not execute the agent when the run was canceled before start", async () => {
    const canceledRun = {
      ...run,
      status: "canceled" as const,
      triageStatus: "handled" as const,
      completedAt: "2026-06-18T09:00:05.000Z",
    };
    const startAutomationRun = vi.fn(() => canceledRun);
    const finishAutomationRun = vi.fn();
    const runAgent = vi.fn(() => completedAgentRun());

    await expect(
      runAutomationHeadless(run, automation, {
        startAutomationRun,
        finishAutomationRun,
        runAgent,
      }),
    ).resolves.toBe(canceledRun);

    expect(runAgent).not.toHaveBeenCalled();
    expect(finishAutomationRun).not.toHaveBeenCalled();
  });

  it("creates a detached git worktree for worktree-mode project runs", async () => {
    const runGit = vi.fn(async (args: string[], _opts?: { cwd?: string }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "true\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const removeDir = vi.fn(async () => undefined);

    const prepared = await prepareAutomationExecutionWorkspace(
      run,
      {
        ...automation,
        runMode: "worktree",
      },
      {
        makeTempDir: async () => "/tmp/filework-automation-run-1",
        removeDir,
        runGit,
      },
    );

    expect(prepared.workspacePath).toBe("/tmp/filework-automation-run-1");
    expect(runGit).toHaveBeenCalledWith(
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: "/workspace",
      },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", "/tmp/filework-automation-run-1", "HEAD"],
      { cwd: "/workspace" },
    );

    await prepared.cleanup();

    expect(runGit).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", "/tmp/filework-automation-run-1"],
      { cwd: "/workspace" },
    );
    expect(removeDir).toHaveBeenCalledWith("/tmp/filework-automation-run-1");
  });
});
