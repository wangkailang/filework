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
  type AutomationRunStatus,
  finishAutomationRun,
  recordAutomationRunEvent,
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
  recordAutomationRunEvent?: typeof recordAutomationRunEvent;
  runAgent?: AutomationRunAgent;
}

type FinishedAutomationRunStatus = Extract<
  AutomationRunStatus,
  "needs_action" | "succeeded" | "failed" | "canceled"
>;

interface AutomationAgentRunResult {
  errorMessage?: string | null;
  needsActionReason?: string | null;
  output: string;
  status: FinishedAutomationRunStatus;
  usage?: TokenUsage;
  workspacePath?: string;
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
  "runProcess",
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
  if (call.toolName === "runCommand" || call.toolName === "runProcess") {
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
  if (run.needsActionReason || run.output) {
    lines.push("", "Continuation context:");
    if (run.needsActionReason) {
      lines.push(`Previous needs-action reason: ${run.needsActionReason}`);
    }
    if (run.output) {
      lines.push("Previous output:", run.output);
    }
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
    const { model, modelId, generationOptions, providerOptions } =
      getModelAndAdapterByConfigId(run.modelId ?? undefined);
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
      providerOptions,
      temperature: generationOptions.temperature,
      topP: generationOptions.topP,
      maxOutputTokens: generationOptions.maxOutputTokens,
      agentId: run.id,
      hooks: { beforeToolCall: headlessBeforeToolCall },
      classifyError: (err) => {
        const c = classifyError(err);
        return {
          type: c.type,
          retryable: c.retryable,
          maxRetries: c.maxRetries,
          backoffMs: c.backoffMs,
          userMessage: c.userMessage,
          recoveryActions: c.recoveryActions,
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

const addUsage = (
  total: TokenUsage | undefined,
  usage: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (!usage) return total;
  if (!total) return { ...usage };
  return {
    inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (usage.totalTokens ?? 0),
  };
};

const getScopedRuns = (
  run: AutomationRunRecord,
  automation: AutomationRecord,
): AutomationRunRecord[] => {
  if (automation.type !== "project" || !run.workspacePaths?.length) {
    return [run];
  }
  if (run.workspacePaths.length === 1) return [run];
  return run.workspacePaths.map((workspacePath) => ({
    ...run,
    workspacePaths: [workspacePath],
  }));
};

const formatScopedOutput = (results: AutomationAgentRunResult[]): string => {
  if (results.length <= 1) return results[0]?.output ?? "";
  return results
    .map((result) => {
      const title = result.workspacePath ?? "-";
      return `### ${title}\n\n${result.output}`.trim();
    })
    .join("\n\n");
};

const consumeAutomationAgentRun = async (
  scopedRun: AutomationRunRecord,
  automation: AutomationRecord,
  runAgent: AutomationRunAgent,
  recordEvent: typeof recordAutomationRunEvent,
): Promise<AutomationAgentRunResult> => {
  let output = "";
  let needsActionReason: string | null = null;
  let usage: TokenUsage | undefined;
  const safeRecordEvent = (
    input: Parameters<typeof recordAutomationRunEvent>[1],
  ) => {
    try {
      recordEvent(scopedRun.id, input);
    } catch {
      // Event persistence is observational; the run result remains authoritative.
    }
  };
  try {
    for await (const event of runAgent(scopedRun, automation)) {
      if (event.type === "message_update") {
        output += event.deltaText;
        safeRecordEvent({
          message: event.deltaText,
          type: "message_update",
        });
      }
      if (event.type === "tool_execution_end") {
        const result = event.result as
          | { denied?: boolean; reason?: unknown }
          | undefined;
        if (result?.denied === true) {
          needsActionReason =
            typeof result.reason === "string"
              ? result.reason
              : "Automation requires manual action before it can continue.";
        }
        safeRecordEvent({
          detail: {
            durationMs: event.durationMs,
            success: event.success,
            toolCallId: event.toolCallId,
          },
          message: result?.denied === true ? needsActionReason : null,
          toolName: event.toolName,
          type: "tool_execution_end",
        });
      }
      if (event.type !== "agent_end") continue;

      usage = event.totalUsage;
      if (typeof event.finalText === "string") output = event.finalText;
      safeRecordEvent({
        detail: {
          status: event.status,
          usage,
        },
        message: output,
        type: "agent_end",
      });

      if (needsActionReason) {
        return {
          status: "needs_action",
          output,
          errorMessage: needsActionReason,
          needsActionReason,
          usage,
          workspacePath: scopedRun.workspacePaths?.[0],
        };
      }

      if (event.status === "failed") {
        return {
          status: "failed",
          output,
          errorMessage: event.error?.message ?? "Automation run failed",
          usage,
          workspacePath: scopedRun.workspacePaths?.[0],
        };
      }

      return {
        status: event.status === "cancelled" ? "canceled" : "succeeded",
        output,
        usage,
        workspacePath: scopedRun.workspacePaths?.[0],
      };
    }

    return {
      status: "succeeded",
      output,
      usage,
      workspacePath: scopedRun.workspacePaths?.[0],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      output,
      errorMessage: message,
      usage,
      workspacePath: scopedRun.workspacePaths?.[0],
    };
  }
};

const aggregateAutomationRunResults = (
  results: AutomationAgentRunResult[],
): AutomationAgentRunResult => {
  const status =
    results.find((result) => result.status === "needs_action")?.status ??
    results.find((result) => result.status === "failed")?.status ??
    results.find((result) => result.status === "canceled")?.status ??
    "succeeded";
  const needsAction = results.find((result) => result.needsActionReason);
  const failed = results.find((result) => result.errorMessage);
  const usage = results.reduce<TokenUsage | undefined>(
    (total, result) => addUsage(total, result.usage),
    undefined,
  );

  return {
    status,
    output: formatScopedOutput(results),
    errorMessage: needsAction?.needsActionReason ?? failed?.errorMessage,
    needsActionReason: needsAction?.needsActionReason,
    usage,
  };
};

export const runAutomationHeadless = async (
  run: AutomationRunRecord,
  automation: AutomationRecord,
  {
    startAutomationRun: startRun = startAutomationRun,
    finishAutomationRun: finishRun = finishAutomationRun,
    recordAutomationRunEvent: recordEvent = recordAutomationRunEvent,
    runAgent = createDefaultAgentRun,
  }: AutomationRunnerDeps = {},
): Promise<AutomationRunRecord> => {
  const startedRun = startRun(run.id);
  if (startedRun.status === "canceled") return startedRun;

  const results = [];
  for (const scopedRun of getScopedRuns(startedRun, automation)) {
    results.push(
      await consumeAutomationAgentRun(
        scopedRun,
        automation,
        runAgent,
        recordEvent,
      ),
    );
  }
  const result = aggregateAutomationRunResults(results);
  const finishInput: Parameters<typeof finishRun>[1] = {
    status: result.status,
    output: result.output,
    usage: result.usage,
  };
  if (result.errorMessage !== undefined) {
    finishInput.errorMessage = result.errorMessage;
  }
  if (result.needsActionReason !== undefined) {
    finishInput.needsActionReason = result.needsActionReason;
  }

  return finishRun(run.id, finishInput);
};
