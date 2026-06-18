import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { classifyError } from "../ai/error-classifier";
import { AgentLoop } from "../core/agent/agent-loop";
import type { AgentEvent, TokenUsage } from "../core/agent/events";
import type { BeforeToolCallHook } from "../core/agent/tool-registry";
import { runGit, withCloneLock } from "../core/workspace/clone-cache";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import { isGitBackedWorkspace } from "../core/workspace/workspace-factory";
import { readWorkspaceMemory } from "../core/workspace/workspace-memory";
import {
  type AutomationRecord,
  type AutomationRunRecord,
  finishAutomationRun,
  startAutomationRun,
} from "../db";
import { buildAgentToolRegistry } from "./agent-tools";
import { getModelAndAdapterByConfigId } from "./ai-models";
import { buildAgentSystemPrompt } from "./system-prompt";

type AutomationRunAgent = (
  run: AutomationRunRecord,
  automation: AutomationRecord,
) => AsyncIterable<AgentEvent>;

interface AutomationRunnerDeps {
  startAutomationRun?: typeof startAutomationRun;
  finishAutomationRun?: typeof finishAutomationRun;
  runAgent?: AutomationRunAgent;
}

interface AutomationExecutionWorkspace {
  cleanup: () => Promise<void>;
  workspacePath: string;
}

interface AutomationExecutionWorkspaceDeps {
  makeTempDir?: () => Promise<string>;
  removeDir?: (workspacePath: string) => Promise<void>;
  runGit?: typeof runGit;
}

const HEADLESS_ALLOWED_TOOLS = [
  "listDirectory",
  "readFile",
  "directoryStats",
  "searchFiles",
  "getCacheStats",
  "clearDirectoryCache",
  "runCommand",
  "readShellOutput",
  "killShell",
  "webFetch",
  "webFetchRendered",
  "webSearch",
  "webScrape",
  "youtubeTranscript",
];

const headlessSender = {
  send: () => undefined,
  isDestroyed: () => false,
} as unknown as WebContents;

const headlessBeforeToolCall: BeforeToolCallHook = async (call) => {
  if (call.toolName === "runCommand") {
    const args = call.args as { escalatePermissions?: boolean };
    if (args.escalatePermissions === true) {
      return {
        allow: false,
        reason: "无头自动化不允许提权命令;请在 Triage 中手动处理。",
      };
    }
    return { allow: true };
  }

  return {
    allow: false,
    reason: "无头自动化不允许需要审批的破坏性操作。",
  };
};

const buildAutomationPrompt = (
  run: AutomationRunRecord,
  automation: AutomationRecord,
): string => {
  const lines = [
    `Automation: ${run.automationTitle}`,
    `Trigger: ${run.trigger}`,
    `Type: ${automation.type}`,
    `Schedule: ${automation.scheduleKind} ${automation.scheduleValue}`,
  ];
  if (run.workspacePaths?.length) {
    lines.push(`Workspace paths: ${run.workspacePaths.join(", ")}`);
  }
  lines.push(
    "",
    "Instructions:",
    run.prompt,
    "",
    "Return a concise triage summary. If there is nothing actionable, say so clearly.",
  );
  return lines.join("\n");
};

const makeAutomationWorktreeDir = (runId: string): Promise<string> => {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return mkdtemp(path.join(tmpdir(), `filework-automation-${safeRunId}-`));
};

const removeAutomationWorktreeDir = async (
  workspacePath: string,
): Promise<void> => {
  await rm(workspacePath, { force: true, recursive: true });
};

export const prepareAutomationExecutionWorkspace = async (
  run: AutomationRunRecord,
  automation: AutomationRecord,
  {
    makeTempDir = () => makeAutomationWorktreeDir(run.id),
    removeDir = removeAutomationWorktreeDir,
    runGit: git = runGit,
  }: AutomationExecutionWorkspaceDeps = {},
): Promise<AutomationExecutionWorkspace> => {
  const sourcePath = run.workspacePaths?.[0] ?? homedir();

  if (automation.runMode !== "worktree") {
    return { cleanup: async () => undefined, workspacePath: sourcePath };
  }

  const probe = await git(["rev-parse", "--is-inside-work-tree"], {
    cwd: sourcePath,
  });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    throw new Error("Automation worktree mode requires a git workspace.");
  }

  return withCloneLock(sourcePath, async () => {
    const workspacePath = await makeTempDir();
    const add = await git(
      ["worktree", "add", "--detach", workspacePath, "HEAD"],
      { cwd: sourcePath },
    );

    if (add.exitCode !== 0) {
      await removeDir(workspacePath);
      throw new Error(
        `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`,
      );
    }

    return {
      cleanup: async () => {
        await git(["worktree", "remove", "--force", workspacePath], {
          cwd: sourcePath,
        }).catch(() => undefined);
        await removeDir(workspacePath);
      },
      workspacePath,
    };
  });
};

const createDefaultAgentRun: AutomationRunAgent = async function* (
  run,
  automation,
) {
  const executionWorkspace = await prepareAutomationExecutionWorkspace(
    run,
    automation,
  );
  try {
    const workspacePath = executionWorkspace.workspacePath;
    const workspace = new LocalWorkspace(workspacePath);
    const { model, adapter, modelId } = getModelAndAdapterByConfigId(
      run.modelId ?? undefined,
    );
    const isGitWorkspace = isGitBackedWorkspace(workspace);
    const workspaceMemory = await readWorkspaceMemory(workspace);
    const systemPrompt = buildAgentSystemPrompt({
      workspacePath,
      modelName: modelId,
      isGitWorkspace,
      workspaceMemory,
    });
    const toolRegistry = buildAgentToolRegistry({
      sender: headlessSender,
      taskId: run.id,
      allowedTools: HEADLESS_ALLOWED_TOOLS,
      modelName: modelId,
      isGitWorkspace,
      workspacePath,
      currentThreadId: automation.threadId ?? undefined,
    });

    const agentLoop = new AgentLoop({
      workspace,
      model,
      tools: toolRegistry,
      systemPrompt,
      providerOptions: adapter.buildProviderOptions(),
      agentId: run.id,
      hooks: { beforeToolCall: headlessBeforeToolCall },
      classifyError: (err) => {
        const c = classifyError(err);
        return {
          type: c.type,
          retryable: c.retryable,
          maxRetries: c.maxRetries,
          backoffMs: c.backoffMs,
        };
      },
      maxWallMs: 30 * 60_000,
      maxTotalTokens: 60_000,
    });

    for await (const event of agentLoop.run(
      buildAutomationPrompt(run, automation),
    )) {
      yield event;
    }
  } finally {
    await executionWorkspace.cleanup();
  }
};

export const runAutomationHeadless = async (
  run: AutomationRunRecord,
  automation: AutomationRecord,
  {
    startAutomationRun: startRun = startAutomationRun,
    finishAutomationRun: finishRun = finishAutomationRun,
    runAgent = createDefaultAgentRun,
  }: AutomationRunnerDeps = {},
): Promise<AutomationRunRecord> => {
  startRun(run.id);

  let output = "";
  let usage: TokenUsage | undefined;
  try {
    for await (const event of runAgent(run, automation)) {
      if (event.type === "message_update") {
        output += event.deltaText;
      }
      if (event.type !== "agent_end") continue;

      usage = event.totalUsage;
      if (typeof event.finalText === "string") output = event.finalText;

      if (event.status === "failed") {
        return finishRun(run.id, {
          status: "failed",
          output,
          errorMessage: event.error?.message ?? "Automation run failed",
          usage,
        });
      }

      return finishRun(run.id, {
        status: event.status === "cancelled" ? "canceled" : "succeeded",
        output,
        usage,
      });
    }

    return finishRun(run.id, {
      status: "succeeded",
      output,
      usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finishRun(run.id, {
      status: "failed",
      output,
      errorMessage: message,
      usage,
    });
  }
};
