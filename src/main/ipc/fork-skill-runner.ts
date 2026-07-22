/**
 * Fork 模式技能 runner。
 *
 * M2 PR 3 迁移后,`skills-runtime/executor.ts:executeSubagent` 的运行时一半。
 * 负责:
 *   - 每次调用的 `LocalWorkspace` + `ToolRegistry`(通过 `buildAgentToolRegistry` 构建)
 *   - 与主 agent 路径相同的 `beforeToolCall` 审批钩子
 *   - 一个 `AgentLoop` 实例,带有自己的 `AbortController`,
 *     并链接到父级 signal,使中止能干净地传播
 *   - 将事件转换到现有 `ai:stream-*` 通道上的 IPC(delta、
 *     tool-call、tool-result、retry、error)。不发出 `ai:stream-done`
 *     —— 那由父级负责(`ai-handlers.ts:376`)。
 *
 * skills-runtime 的 `executeSubagent` 通过新的
 * `ExecutorDeps.runSubagent` 回调调用本模块。这使 skills-runtime 无需
 * 关心 IPC / Electron / AgentLoop。
 */

import type { ModelMessage } from "ai";
import type { WebContents } from "electron";

import { compressContext } from "../ai/context-compressor";
import { DeltaBatcher } from "../ai/delta-batcher";
import { classifyError } from "../ai/error-classifier";
import { appendPattern } from "../ai/pattern-store";
import { StreamWatchdog } from "../ai/stream-watchdog";
import { estimateTokens } from "../ai/token-budget";
import { buildBrowserPolicyHook } from "../browser/browser-policy";
import { AgentLoop } from "../core/agent/agent-loop";
import { consumePreview } from "../core/agent/preview/snapshot-store";
import type {
  ReflectionVerdict,
  TurnSummary,
} from "../core/agent/reflection-gate";
import { ResearchLoopGuard } from "../core/agent/research-loop-guard";
import type { ClassifiedRetryError } from "../core/agent/retry";
import {
  buildReport,
  DEFAULT_SUB_AGENT_MAX_TOKENS,
  DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS,
  DEFAULT_SUB_AGENT_MAX_WALL_MS,
  DEFAULT_SUB_AGENT_RESULT_SCHEMA,
  extractJsonArtifacts,
  type SubAgentContract,
  type SubAgentReport,
  type SubAgentStatus,
} from "../core/agent/sub-agent-contract";
import {
  type BeforeToolCallDecision,
  type BeforeToolCallHook,
  composeBeforeToolCallHooks,
  type ToolDefinition,
} from "../core/agent/tool-registry";
import { isDeliverableCommand } from "../core/agent/tools/command-classify";
import { prepareIsolatedGitWorktree } from "../core/workspace/git-worktree";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import { isGitBackedWorkspace } from "../core/workspace/workspace-factory";
import {
  buildAgentToolRegistry,
  getAgentBrowserToolsDependencies,
} from "./agent-tools";
import { getModelAndAdapterByConfigId } from "./ai-models";
import { buildApprovalHook } from "./approval-hook";

export interface ForkSkillRunnerDeps {
  sender: WebContents;
  taskId: string;
  parentSignal: AbortSignal;
  workspacePath: string;
  /** 当技能的 `model` frontmatter 覆盖失败时用作回退。 */
  llmConfigId?: string;
  /**
   * 设置后,本 runner 走 spawnSubagent 路径:事件改发 ai:subagent-*
   * (携带 parentTaskId / batchId / childTaskId)而非 ai:stream-*,使渲染层
   * 能把进度挂到对应的 subagent 进度卡而不是当成主任务文本。
   * 缺省(legacy context:fork 技能路径)则保持 ai:stream-*,向后兼容。
   */
  parentTaskId?: string;
  /** spawnSubagent 路径:所属批次 id,用于 UI 定位进度卡。 */
  batchId?: string;
}

export interface RunSubagentOptions {
  /** 已由 skills-runtime 用 `wrapWithSecurityBoundary` 包装。 */
  systemPrompt: string;
  workspacePath: string;
  /** 面向用户的 prompt —— 作为新一轮输入喂给 AgentLoop。 */
  prompt: string;
  history?: ModelMessage[];
  /** 技能 frontmatter 的 `allowed-tools` 列表。空/undefined → 零工具。 */
  allowedTools?: string[];
  /** spawned subagent 写入隔离模式。默认不隔离,直接写工具请求会触发 worktree。 */
  isolationMode?: "worktree";
  /** 技能 frontmatter 的 `model` 覆盖项。失败时回退到 llmConfigId。 */
  modelOverrideId?: string;
  /** 覆盖每轮的步数上限(默认 20)。 */
  maxStepsPerTurn?: number;
  /**
   * 子 agent 契约。提供时,output 格式 / termination 会约束
   * runner。省略时,默认走自由格式的 summary 运行,
   * 使旧的 fork-skill 调用方继续可用。
   */
  contract?: SubAgentContract;
}

export type RunSubagentFn = (
  opts: RunSubagentOptions,
) => Promise<SubAgentReport>;

const fallbackContract = (prompt: string): SubAgentContract => ({
  goal: "sub-agent run",
  input: { prompt },
  output: { format: "summary" },
  termination: {},
});

/**
 * 基于字符数的 summary 回退。精确按 token 的摘要属于
 * 二期事项 —— MVP 阶段按每 token 约 4 字符封顶,
 * 使报告无需额外 LLM 调用即可控制在预算内。
 */
const truncateForSummary = (text: string, maxTokens: number): string => {
  const charCap = maxTokens * 4;
  if (text.length <= charCap) return text;
  return `${text.slice(0, charCap)}... [summary truncated]`;
};

const SUBAGENT_SHELL_WRITE_DENIED =
  "Sub-agent shell is read-only. Return findings or a patch suggestion to the parent agent instead of modifying files.";
const SUBAGENT_SHELL_ESCALATION_DENIED =
  "Sub-agents cannot request shell permission escalation; use read-only inspection commands only.";
const SUBAGENT_BACKGROUND_SHELL_DENIED =
  "Sub-agents cannot start background shell processes; use bounded read-only inspection commands only.";
const SUBAGENT_RESULT_TOOL_NAME = "submitSubagentResult";
const SUBAGENT_CONTEXT_COMPRESSION_TRIGGER_RATIO = 0.7;
const SUBAGENT_CONTEXT_COMPRESSION_TARGET_RATIO = 0.65;
const SUBAGENT_GRACEFUL_TOKEN_RATIO = 0.8;
const SUBAGENT_GRACEFUL_MIN_WALL_MS = 5_000;
const SUBAGENT_GRACEFUL_MAX_WALL_MS = 30_000;
const SUBAGENT_GRACEFUL_WALL_RATIO = 0.2;
const SUBAGENT_GRACEFUL_MESSAGE =
  "Wrap up now. Do not call more research tools. Call submitSubagentResult exactly once with status=complete if the assigned goal is covered, otherwise status=partial or no_result with missing gaps, then stop.";
const SUBAGENT_STEP_LIMIT_MESSAGE =
  "The exploration step budget is exhausted. Do not call more tools. Return RESULT_JSON followed by one fenced JSON object using the required result schema. Preserve every validated finding and list remaining gaps; do not return a process note.";
const SUBAGENT_DIRECT_WRITE_TOOL_SET = new Set([
  "writeFile",
  "moveFile",
  "deleteFile",
  "restoreFromTrash",
  "emptyTrash",
]);
const SUBAGENT_DIRECT_WRITE_DENIED =
  "Sub-agent direct writes require an isolated git worktree. Return a patch artifact to the parent agent instead.";

const shellCommandForCall = (
  toolName: string,
  args: unknown,
): string | null => {
  if (args === null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (toolName === "runCommand") {
    return typeof record.command === "string" ? record.command : null;
  }
  if (toolName !== "runProcess") return null;
  if (typeof record.executable !== "string") return null;
  const argv = Array.isArray(record.args) ? record.args : [];
  return [record.executable, ...argv.map((arg) => String(arg))].join(" ");
};

const subagentReadOnlyShellGuard = (
  call: Parameters<BeforeToolCallHook>[0],
): BeforeToolCallDecision | null => {
  if (call.toolName !== "runCommand" && call.toolName !== "runProcess") {
    return null;
  }
  const args =
    call.args !== null && typeof call.args === "object"
      ? (call.args as Record<string, unknown>)
      : {};
  if (args.escalatePermissions === true) {
    return { allow: false, reason: SUBAGENT_SHELL_ESCALATION_DENIED };
  }
  if (args.runInBackground === true) {
    return { allow: false, reason: SUBAGENT_BACKGROUND_SHELL_DENIED };
  }
  const command = shellCommandForCall(call.toolName, call.args);
  if (command && isDeliverableCommand(command)) {
    return { allow: false, reason: SUBAGENT_SHELL_WRITE_DENIED };
  }
  return null;
};

const subagentRequestsDirectWrite = (
  allowedTools: string[] | undefined,
): boolean =>
  (allowedTools ?? []).some((toolName) =>
    SUBAGENT_DIRECT_WRITE_TOOL_SET.has(toolName),
  );

const submittedArtifactsFromToolOutput = (
  output: unknown,
): Record<string, unknown> | undefined => {
  if (!output || typeof output !== "object") return undefined;
  const record = output as Record<string, unknown>;
  const candidate =
    record.artifacts && typeof record.artifacts === "object"
      ? record.artifacts
      : record;
  const parsed = DEFAULT_SUB_AGENT_RESULT_SCHEMA.safeParse(candidate);
  return parsed.success ? (parsed.data as Record<string, unknown>) : undefined;
};

const clipFinalizationEvidence = (value: unknown, maxChars = 1_200): string => {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}...[truncated]`;
};

const buildFinalizationEvidence = (summary: TurnSummary): string =>
  summary.toolCalls
    .slice(-8)
    .map(
      (call, index) =>
        `${index + 1}. ${call.name} (${call.success ? "ok" : "failed"}): ${clipFinalizationEvidence(call.result)}`,
    )
    .join("\n");

const buildSubmitSubagentResultTool = (
  onSubmit: (artifacts: Record<string, unknown>) => void,
): ToolDefinition<unknown, unknown> => ({
  name: SUBAGENT_RESULT_TOOL_NAME,
  description:
    "Submit the sub-agent's structured result exactly once, when the assigned goal is done or genuinely blocked. Use status=complete only for a result the lead can rely on; use partial to preserve evidenced findings with explicit gaps, or no_result for diagnostics, and then stop.",
  inputSchema: DEFAULT_SUB_AGENT_RESULT_SCHEMA,
  safety: "safe",
  execute: async (args) => {
    const parsed = DEFAULT_SUB_AGENT_RESULT_SCHEMA.safeParse(args);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.message,
      };
    }
    const artifacts = parsed.data as Record<string, unknown>;
    onSubmit(artifacts);
    return {
      success: true,
      accepted: true,
      artifacts,
      instruction:
        "Result recorded. End now or provide only a very short note.",
    };
  },
});

/**
 * 构建一个绑定到当前任务的 `runSubagent` 回调。每次调用都会
 * 解析 model/adapter、构造 AgentLoop,并将事件
 * 通过现有 IPC 通道转换回渲染层。
 */
export const createForkSkillRunner = (
  deps: ForkSkillRunnerDeps,
): RunSubagentFn => {
  const { sender, taskId, parentSignal, llmConfigId, parentTaskId, batchId } =
    deps;
  // spawnSubagent 路径:事件走 ai:subagent-* + parentTaskId 路由。
  const isSubagent = parentTaskId !== undefined;
  const routePayload = <T extends Record<string, unknown>>(extra: T) =>
    isSubagent
      ? { parentTaskId, batchId, childTaskId: taskId, ...extra }
      : { id: taskId, ...extra };

  return async (opts) => {
    const startTime = Date.now();
    const effectiveContract = opts.contract ?? fallbackContract(opts.prompt);
    // ── 解析 model + adapter ─────────────────────────────────────
    let resolved: ReturnType<typeof getModelAndAdapterByConfigId>;
    if (opts.modelOverrideId) {
      try {
        resolved = getModelAndAdapterByConfigId(opts.modelOverrideId);
      } catch (err) {
        console.warn(
          `[fork-skill-runner] Model override "${opts.modelOverrideId}" failed; falling back to default:`,
          err instanceof Error ? err.message : err,
        );
        resolved = getModelAndAdapterByConfigId(llmConfigId);
      }
    } else {
      resolved = getModelAndAdapterByConfigId(llmConfigId);
    }
    const { model, modelId, generationOptions, providerOptions } = resolved;

    // ── 每次调用的组件 ─────────────────────────────────────────────
    const isolatedWorktree =
      isSubagent &&
      (opts.isolationMode === "worktree" ||
        subagentRequestsDirectWrite(opts.allowedTools))
        ? await prepareIsolatedGitWorktree(opts.workspacePath, { id: taskId })
        : undefined;
    const effectiveWorkspacePath =
      isolatedWorktree?.workspacePath ?? opts.workspacePath;
    const workspace = new LocalWorkspace(effectiveWorkspacePath);
    const isGitWorkspace = isGitBackedWorkspace(workspace);
    let submittedArtifacts: Record<string, unknown> | undefined;
    const researchLoopGuard = isSubagent ? new ResearchLoopGuard() : undefined;
    const reflectSubagentFinalization = async (
      summary: TurnSummary,
    ): Promise<ReflectionVerdict> => {
      if (submittedArtifacts || summary.endReason !== "tool_calls") {
        return { kind: "continue" };
      }
      const evidence = buildFinalizationEvidence(summary);
      return {
        kind: "retry",
        forceNoTools: true,
        feedback: `${SUBAGENT_STEP_LIMIT_MESSAGE}${
          evidence
            ? `\n\nEvidence ledger from completed tool calls:\n${evidence}`
            : ""
        }`,
      };
    };
    // undefined 时强制为 [],使 registry 的 allow() 过滤(零工具
    // 默认)与旧的 `executor.ts:395-397` 行为一致。
    const toolRegistry = buildAgentToolRegistry({
      sender,
      taskId,
      allowedTools: opts.allowedTools ?? [],
      modelName: modelId,
      isGitWorkspace,
    });
    if (isSubagent) {
      toolRegistry.register(
        buildSubmitSubagentResultTool((artifacts) => {
          submittedArtifacts = artifacts;
        }),
      );
    }
    const approvalHook = buildApprovalHook({
      sender,
      taskId,
      workspace,
      approvalPolicy: isolatedWorktree ? "never" : undefined,
      sandboxMode: isolatedWorktree ? "workspace-write" : undefined,
    });
    const beforeToolCall: BeforeToolCallHook = async (call, ctx) => {
      if (isSubagent) {
        if (
          SUBAGENT_DIRECT_WRITE_TOOL_SET.has(call.toolName) &&
          !isolatedWorktree
        ) {
          return { allow: false, reason: SUBAGENT_DIRECT_WRITE_DENIED };
        }
        const guardDecision = subagentReadOnlyShellGuard(call);
        if (guardDecision) return guardDecision;
      }
      return approvalHook(call, ctx);
    };
    const browserDependencies = getAgentBrowserToolsDependencies();
    const browserPolicyHook = browserDependencies
      ? buildBrowserPolicyHook({
          manager: browserDependencies.manager,
          observer: browserDependencies.observer,
          sender,
          taskId,
        })
      : undefined;

    // 子 AbortController,使 runner 能对自身的
    // 失败做出反应而不中止父级。父级中止只转发一次。
    const childController = new AbortController();
    const onParentAbort = () => {
      if (!childController.signal.aborted) childController.abort();
    };
    if (parentSignal.aborted) {
      childController.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    // 墙钟时间守卫。对旧调用方默认无上限;仅当
    // 契约显式启用时才生效(显式 maxWallMs > 0,或提供了任意
    // 契约 —— 此时启用默认值)。
    let timedOut = false;
    const rawWallMs = effectiveContract.termination.maxWallMs;
    const effectiveWallMs =
      typeof rawWallMs === "number" && rawWallMs > 0
        ? rawWallMs
        : opts.contract && rawWallMs === undefined
          ? DEFAULT_SUB_AGENT_MAX_WALL_MS
          : undefined;
    const rawTotalTokens = effectiveContract.termination.maxTotalTokens;
    const effectiveMaxTotalTokens =
      typeof rawTotalTokens === "number" && rawTotalTokens > 0
        ? rawTotalTokens
        : opts.contract && rawTotalTokens === undefined
          ? DEFAULT_SUB_AGENT_MAX_TOTAL_TOKENS
          : undefined;
    const wallTimer = effectiveWallMs
      ? setTimeout(() => {
          if (!childController.signal.aborted) {
            timedOut = true;
            childController.abort();
          }
        }, effectiveWallMs)
      : undefined;

    const deltaBatcher = new DeltaBatcher({
      flush: (text) => {
        if (!sender.isDestroyed()) {
          sender.send(
            isSubagent ? "ai:subagent-delta" : "ai:stream-delta",
            routePayload({ delta: text }),
          );
        }
      },
    });

    const watchdog = new StreamWatchdog({
      taskId,
      sender,
      abortController: childController,
    });
    watchdog.start();

    const registryTools = toolRegistry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace,
        signal: childController.signal,
        toolCallId,
      }),
      beforeAnyToolCall: composeBeforeToolCallHooks(
        browserPolicyHook,
        researchLoopGuard
          ? async (call) => researchLoopGuard.beforeToolCall(call)
          : undefined,
      ),
      beforeToolCall,
      onToolResult: researchLoopGuard
        ? (result) => researchLoopGuard.observeToolResult(result)
        : undefined,
    });

    const systemPrompt = `${opts.systemPrompt}\n\nCurrent workspace: ${effectiveWorkspacePath}`;
    const systemPromptTokens = estimateTokens([
      { role: "system", content: systemPrompt },
    ]);
    const estimateSubagentStepTokens = (messages: ModelMessage[]) =>
      estimateTokens([{ role: "system", content: systemPrompt }, ...messages]);
    const transformSubagentStepContext =
      isSubagent && effectiveMaxTotalTokens
        ? async (messages: ModelMessage[], signal?: AbortSignal) => {
            const originalTokens = estimateSubagentStepTokens(messages);
            const compressionTriggerTokens = Math.floor(
              effectiveMaxTotalTokens *
                SUBAGENT_CONTEXT_COMPRESSION_TRIGGER_RATIO,
            );
            const exceedsTrigger = originalTokens >= compressionTriggerTokens;
            const exceedsHardBudget = originalTokens >= effectiveMaxTotalTokens;
            if (!exceedsTrigger && !exceedsHardBudget) {
              return { messages };
            }

            const result = await compressContext(messages, {
              model,
              budget: Math.max(
                1,
                Math.floor(
                  effectiveMaxTotalTokens *
                    SUBAGENT_CONTEXT_COMPRESSION_TARGET_RATIO,
                ) - systemPromptTokens,
              ),
              force: true,
              tailBudget: 4_000,
              signal,
              taskId,
              promptSnippet: effectiveContract.goal,
            });
            return {
              messages: result.messages,
              originalTokens,
              compressedTokens: estimateSubagentStepTokens(result.messages),
            };
          }
        : undefined;
    const gracefulWallMsRemaining = effectiveWallMs
      ? Math.min(
          SUBAGENT_GRACEFUL_MAX_WALL_MS,
          Math.max(
            SUBAGENT_GRACEFUL_MIN_WALL_MS,
            Math.floor(effectiveWallMs * SUBAGENT_GRACEFUL_WALL_RATIO),
          ),
        )
      : undefined;

    const agentLoop = new AgentLoop({
      workspace,
      model,
      tools: registryTools,
      systemPrompt,
      history: opts.history,
      providerOptions,
      temperature: generationOptions.temperature,
      topP: generationOptions.topP,
      maxOutputTokens: generationOptions.maxOutputTokens,
      signal: childController.signal,
      agentId: taskId,
      maxStepsPerTurn:
        effectiveContract.termination.maxTurns ?? opts.maxStepsPerTurn ?? 20,
      // 三硬上限下沉到 AgentLoop 统一强制。墙钟同时保留上面的外层
      // setTimeout 作兜底(防 AgentLoop 卡在非 stream 的 await)。
      maxTotalTokens: effectiveMaxTotalTokens,
      maxWallMs: effectiveWallMs,
      gracefulShutdown: isSubagent
        ? {
            tokenBudgetRatio: effectiveMaxTotalTokens
              ? SUBAGENT_GRACEFUL_TOKEN_RATIO
              : undefined,
            wallMsRemaining: gracefulWallMsRemaining,
            finalTools: [SUBAGENT_RESULT_TOOL_NAME],
            message: SUBAGENT_GRACEFUL_MESSAGE,
          }
        : undefined,
      terminalTools: isSubagent ? [SUBAGENT_RESULT_TOOL_NAME] : undefined,
      maxReflections: isSubagent ? 1 : undefined,
      hooks: isSubagent
        ? {
            ...(transformSubagentStepContext
              ? { transformStepContext: transformSubagentStepContext }
              : {}),
            ...(researchLoopGuard
              ? {
                  resolveStepPolicy: () =>
                    researchLoopGuard.getStepPolicy(Object.keys(registryTools)),
                }
              : {}),
            reflect: reflectSubagentFinalization,
          }
        : transformSubagentStepContext
          ? { transformStepContext: transformSubagentStepContext }
          : undefined,
      classifyError: (err): ClassifiedRetryError => {
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
    });

    // 在 agent_end 时供 buildReport 使用的聚合器。
    let toolCallCount = 0;
    let finalTextAccum = "";
    let endEventStatus: "completed" | "failed" | "cancelled" = "completed";
    let endEventError: string | undefined;
    let endStopReason: "max_steps" | "token_budget" | "wall_clock" | undefined;
    let endEventUsage:
      | { inputTokens?: number | null; outputTokens?: number | null }
      | undefined;

    let streamCompleted = false;
    try {
      for await (const ev of agentLoop.run(opts.prompt)) {
        if (sender.isDestroyed()) break;

        switch (ev.type) {
          case "agent_start":
            // ai:stream-start 由父级负责(与
            // 主 agent 路径保持一致)。
            break;
          case "message_update":
            watchdog.activity();
            deltaBatcher.push(ev.deltaText);
            break;
          case "tool_execution_start": {
            deltaBatcher.drain();
            toolCallCount++;
            const previewSnapshot = consumePreview(ev.toolCallId);
            sender.send(
              isSubagent ? "ai:subagent-tool-call" : "ai:stream-tool-call",
              routePayload({
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                args: ev.args,
                previewSnapshot,
              }),
            );
            break;
          }
          case "tool_execution_end":
            if (isSubagent && ev.toolName === SUBAGENT_RESULT_TOOL_NAME) {
              submittedArtifacts =
                submittedArtifactsFromToolOutput(ev.result) ??
                submittedArtifacts;
            }
            sender.send(
              isSubagent ? "ai:subagent-tool-result" : "ai:stream-tool-result",
              routePayload({
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                result: ev.result,
              }),
            );
            break;
          case "retry": {
            // 子 agent 的 retry 是内部细节,不进 UI 进度卡;仅 legacy
            // fork 技能路径转发到主任务的 ai:stream-retry。
            if (!isSubagent) {
              const retryInfo = classifyError(new Error(ev.errorType));
              sender.send("ai:stream-retry", {
                id: taskId,
                attempt: ev.attempt,
                type: ev.errorType,
                maxRetries: retryInfo.maxRetries,
              });
            }
            break;
          }
          case "agent_end": {
            deltaBatcher.drain();
            endEventStatus = ev.status;
            endEventError = ev.error?.message;
            endStopReason = ev.stopReason;
            endEventUsage = ev.totalUsage as typeof endEventUsage;
            finalTextAccum = ev.finalText ?? "";
            // 子 agent 的失败由批次的 ai:subagent-report 承载,不污染主任务
            // 的 ai:stream-error。仅 legacy fork 技能路径转发 error 到主 UI。
            if (ev.status === "failed" && !isSubagent) {
              const cls = ev.error
                ? {
                    type: ev.error.type,
                    userMessage: ev.error.message,
                    recoveryActions: ev.error.recoveryActions,
                  }
                : classifyError(new Error("Subagent failed"));
              const errorMsg =
                cls.userMessage ?? ev.error?.message ?? "Unknown error";
              if (!sender.isDestroyed()) {
                sender.send("ai:stream-error", {
                  id: taskId,
                  error: errorMsg,
                  type: cls.type,
                  recoveryActions: cls.recoveryActions,
                });
              }
            }
            // 子 agent 路径:实时回传最终用量,UI 卡片可显示 token。
            if (isSubagent && !sender.isDestroyed()) {
              sender.send(
                "ai:subagent-child-usage",
                routePayload({ usage: ev.totalUsage }),
              );
            }
            // completed / cancelled / failed 都会落到下面
            // 构建报告的尾部逻辑。ai:stream-done 仍由父级负责。
            break;
          }
        }
      }
      streamCompleted = true;
    } finally {
      deltaBatcher.drain();
      watchdog.stop();
      parentSignal.removeEventListener("abort", onParentAbort);
      if (wallTimer) clearTimeout(wallTimer);
      if (!streamCompleted && isolatedWorktree) {
        await isolatedWorktree.cleanup().catch(() => undefined);
      }
    }

    // ── 构建 SubAgentReport ───────────────────────────────────
    const AGENT_END_TO_REPORT_STATUS: Record<
      typeof endEventStatus,
      SubAgentStatus
    > = {
      completed: "ok",
      cancelled: "cancelled",
      failed: "failed",
    };
    // 状态优先级:外层墙钟兜底 > AgentLoop 的 stopReason(token/wall) >
    // agent_end.status。token 截断映射为 token_limit,wall 截断映射为 timeout。
    const reportStatus: SubAgentStatus = timedOut
      ? "timeout"
      : endStopReason === "token_budget"
        ? "token_limit"
        : endStopReason === "wall_clock"
          ? "timeout"
          : AGENT_END_TO_REPORT_STATUS[endEventStatus];

    const maxTokens =
      effectiveContract.output.maxTokens ?? DEFAULT_SUB_AGENT_MAX_TOKENS;
    const precomputedSummary =
      effectiveContract.output.format === "summary"
        ? truncateForSummary(finalTextAccum, maxTokens)
        : undefined;

    const candidateArtifacts =
      submittedArtifacts ?? extractJsonArtifacts(finalTextAccum);

    let report = buildReport({
      agentId: taskId,
      contract: effectiveContract,
      status: reportStatus,
      finalText: finalTextAccum,
      usage: endEventUsage
        ? {
            inputTokens: endEventUsage.inputTokens ?? null,
            outputTokens: endEventUsage.outputTokens ?? null,
            totalTokens:
              (endEventUsage.inputTokens ?? 0) +
                (endEventUsage.outputTokens ?? 0) || null,
          }
        : undefined,
      toolCallCount,
      durationMs: Date.now() - startTime,
      candidateArtifacts,
      precomputedSummary,
      error: endEventError,
    });

    if (isolatedWorktree) {
      try {
        const patch = await isolatedWorktree.diff();
        report = {
          ...report,
          artifacts: {
            ...(report.artifacts ?? {}),
            isolatedWorktreePatch: patch,
          },
        };
      } catch (err) {
        report = {
          ...report,
          artifacts: {
            ...(report.artifacts ?? {}),
            isolatedWorktreePatch: {
              error: err instanceof Error ? err.message : String(err),
            },
          },
        };
      } finally {
        await isolatedWorktree.cleanup().catch(() => undefined);
      }
    }

    // 为迭代优化层做 fire-and-forget 采集。
    // 未配置存储路径时为空操作(参见 pattern-store)。
    void appendPattern({
      kind: "subagent",
      ts: new Date().toISOString(),
      agentId: report.agentId,
      contractGoal: effectiveContract.goal,
      status: report.status,
      summary: report.summary,
      toolCallCount: report.toolCallCount,
      durationMs: report.durationMs,
      error: report.error,
    });

    return report;
  };
};
