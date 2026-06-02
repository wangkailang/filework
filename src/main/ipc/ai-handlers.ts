/**
 * AI Handlers - 主 IPC Handler 注册
 *
 * 编排 AI 相关的 IPC handler 与任务执行。
 * 这是重构后更精简的主 handler 文件。
 */

import crypto from "node:crypto";
import { ipcMain } from "electron";
import { redactSecrets } from "../../shared/security/secret-detection";
import { resolveAdapterName } from "../ai/adapters";
import { runWithDevtoolsTaskScope } from "../ai/adapters/devtools";
import { compressContext } from "../ai/context-compressor";
import { DeltaBatcher } from "../ai/delta-batcher";
import { classifyError } from "../ai/error-classifier";
import { emitMemoryEvent } from "../ai/memory-debug-store";
import {
  convertToCoreMessages,
  type HistoryMessage,
} from "../ai/message-converter";
import { appendPattern } from "../ai/pattern-store";
import { summarizeLargeToolResults } from "../ai/result-summarizer";
import { StreamWatchdog } from "../ai/stream-watchdog";
import { emitTaskTraceEvent } from "../ai/task-trace-store";
import {
  estimateTokens,
  getTokenBudgetForModel,
  truncateToFitAsync,
} from "../ai/token-budget";
import { AgentLoop } from "../core/agent/agent-loop";
import type { AgentEvent } from "../core/agent/events";
import { consumePreview } from "../core/agent/preview/snapshot-store";
import {
  builtinRules,
  createReflectionGate,
  defaultRules,
} from "../core/agent/reflection-gate";
import type { ClassifiedRetryError } from "../core/agent/retry";
import { LocalWorkspace } from "../core/workspace/local-workspace";
import {
  createWorkspace,
  isGitBackedWorkspace,
  type WorkspaceFactoryDeps,
} from "../core/workspace/workspace-factory";
import { readWorkspaceMemory } from "../core/workspace/workspace-memory";
import { decodeRef, type WorkspaceRef } from "../core/workspace/workspace-ref";
import {
  addTask,
  getDefaultLlmConfig,
  getLlmConfig,
  getSetting,
  setSetting,
  updateTask,
} from "../db";
import { getAllSuggestions, skillRegistry, skills } from "../skills";
import type { ExecutorDeps } from "../skills-runtime";
import {
  executeSkill,
  getTrustLevel,
  initSkillDiscovery,
  preprocessSkill,
  wrapWithSecurityBoundary,
} from "../skills-runtime";
import type { UnifiedSkill } from "../skills-runtime/types";
import { buildAgentToolRegistry } from "./agent-tools";
import { getModelAndAdapterByConfigId } from "./ai-models";
import { registerPlanHandlers } from "./ai-plan-handlers";
import {
  abortControllers,
  awaitPlanGate,
  cleanupTask,
  drainClarificationResolver,
  getActiveTaskForSession,
  getActiveTaskTarget,
  getTaskEvents,
  manualStopFlags,
  pendingApprovals,
  pendingClarifications,
  recordTaskEvent,
  redirectActiveTask,
  registerActiveTask,
  setTaskWorkspace,
  stopTaskExecution,
  toolCallToTaskMap,
} from "./ai-task-control";
import { settleBatch } from "./approval-batcher";
import { buildApprovalHook } from "./approval-hook";
import { createForkSkillRunner } from "./fork-skill-runner";
import { registerMemoryDebugHandlers } from "./memory-debug-handlers";
import { buildAgentSystemPrompt } from "./system-prompt";
import { registerUsageHandlers } from "./usage-handlers";
import { registerWorkspaceMemoryHandlers } from "./workspace-memory-handlers";

// buildSystemPrompt 已抽取到 ./system-prompt.ts(M2 PR 2 —— 领域中立)。

/**
 * 解析任务 payload 的 workspace ref。向后兼容:若渲染层只发了
 * `workspacePath`(遗留方式),则将其当作 local ref 处理。
 */
const resolveWorkspaceRef = (payload: {
  workspaceRefJson?: string;
  workspacePath?: string;
}): WorkspaceRef => {
  if (payload.workspaceRefJson) {
    const ref = decodeRef(payload.workspaceRefJson);
    if (ref) return ref;
  }
  if (payload.workspacePath) {
    return { kind: "local", path: payload.workspacePath };
  }
  throw new Error("Task payload missing workspaceRefJson or workspacePath");
};

let workspaceFactoryDeps: WorkspaceFactoryDeps | null = null;

/** 在主进程 bootstrap 期间一次性接入 workspace factory 依赖。 */
export const setWorkspaceFactoryDeps = (deps: WorkspaceFactoryDeps): void => {
  workspaceFactoryDeps = deps;
};

const requireWorkspaceFactoryDeps = (): WorkspaceFactoryDeps => {
  if (!workspaceFactoryDeps) {
    throw new Error(
      "workspace factory deps not registered — call setWorkspaceFactoryDeps() during bootstrap",
    );
  }
  return workspaceFactoryDeps;
};

/**
 * 主任务执行 handler
 */
const handleTaskExecutionInner = async (
  event: Electron.IpcMainInvokeEvent,
  payload: {
    prompt: string;
    /** 编码后的 WorkspaceRef(优先)。回落到 workspacePath。 */
    workspaceRefJson?: string;
    /** 遗留:绝对路径。被当作 `{kind:"local", path}` 处理。 */
    workspacePath?: string;
    /**
     * 聊天 session id。用作 github 自动分支
     * (`claude/<sessionId.slice(0,8)>`)的按会话作用域。缺失时
     * (skills、测试、临时调用),workspace 回落到由 ref 派生的稳定作用域。
     */
    sessionId?: string;
    /** 渲染层为本回合预生成的助手消息 id;登记进重连表,刷新后据此重挂。 */
    assistantMessageId?: string;
    llmConfigId?: string;
    history?: Array<{ role: string; content: string; parts?: unknown[] }>;
  },
) => {
  const ref = resolveWorkspaceRef(payload);
  // 沙箱 + skill 发现需要一个具体的磁盘路径。对 local ref 来说就是
  // `ref.path`;对 github 来说是 clone 目录,要到下面把 Workspace
  // 物化出来后才知道。
  const legacyWorkspacePath =
    ref.kind === "local" ? ref.path : (payload.workspacePath ?? "");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const taskStartMs = Date.now();
  // 可重定向的发送目标:每次发送时从登记表实时解析当前 webContents
  // (关窗重开后由 ai:reattachTask 改写),回退到最初的 event.sender。下游
  // (agent-tools / approval-batcher)只用 send/isDestroyed,故仅代理这两个方法。
  const originalSender = event.sender;
  const sender = {
    send: (channel: string, ...args: unknown[]) => {
      // 录制每条流事件 —— 重连时按序重放重建消息(零缺口)。所有发送(含
      // agent-tools / approval-batcher)都走此包装器,故录制天然集中且完整。
      recordTaskEvent(id, channel, args[0]);
      const t = getActiveTaskTarget(id) ?? originalSender;
      if (!t.isDestroyed()) t.send(channel, ...args);
    },
    isDestroyed: () =>
      (getActiveTaskTarget(id) ?? originalSender).isDestroyed(),
  } as unknown as Electron.WebContents;

  addTask({
    id,
    workspaceId: "default",
    prompt: payload.prompt,
    status: "running",
    result: null,
    filesAffected: null,
    createdAt: now,
    completedAt: null,
  });

  const controller = new AbortController();
  console.log("[Main] Created AbortController for executeTask taskId:", id);
  abortControllers.set(id, controller);
  // 登记到重连表:刷新后渲染层据 sessionId 查到此 taskId + 助手消息 id 重新挂上。
  registerActiveTask({
    taskId: id,
    sessionId: payload.sessionId,
    assistantMessageId: payload.assistantMessageId,
    target: originalSender,
  });

  try {
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-start", { id });
    }

    // 一旦知道磁盘根目录就调用 setTaskWorkspace。对 local ref 立即可知;
    // 对 GitHub ref 则在下面 clone 物化后再设置。
    if (ref.kind === "local") {
      setTaskWorkspace(id, ref.path);
    }

    emitTaskTraceEvent(sender, {
      taskId: id,
      type: "task-start",
      timestamp: now,
      detail: {
        workspaceKind: ref.kind,
        workspacePath: legacyWorkspacePath,
        hasHistory:
          Array.isArray(payload.history) && payload.history.length > 0,
      },
    });

    const llmConfig = payload.llmConfigId
      ? getLlmConfig(payload.llmConfigId)
      : getDefaultLlmConfig();

    // Phase 1 守卫:只有 "chat" modality 走 agent 循环。图像/视频配置
    // 使用不同的 provider API(例如 MiniMax /v1/image_generation、
    // /v1/video_generation),将在 Phase 2/3 接入。没有这个检查的话,
    // 图像/视频模型名会被转发到 /v1/chat/completions,上游会返回令人
    // 困惑的 "unknown model" 错误。
    if (llmConfig?.modality && llmConfig.modality !== "chat") {
      throw new Error(
        `此 LLM 配置的 modality 是 "${llmConfig.modality}"，聊天路径只支持 "chat"。${
          llmConfig.modality === "image" ? "图像生成" : "视频生成"
        }尚未接入（Phase 2/3 待实现）。请改用 chat 模型，或等待后续版本。`,
      );
    }

    const { model, adapter } = getModelAndAdapterByConfigId(
      payload.llmConfigId,
    );

    emitTaskTraceEvent(sender, {
      taskId: id,
      type: "model-selected",
      timestamp: new Date().toISOString(),
      detail: {
        provider: llmConfig?.provider ?? null,
        modelId: llmConfig?.model ?? null,
      },
    });

    // ── Skill 匹配:先按 /command 格式,再按 prompt 内容 ──
    let skill: UnifiedSkill | undefined;
    let skillArgs = "";
    const isExplicitSkillCommand = payload.prompt.startsWith("/");

    if (isExplicitSkillCommand) {
      const spaceIdx = payload.prompt.indexOf(" ");
      const command =
        spaceIdx > 0 ? payload.prompt.slice(0, spaceIdx) : payload.prompt;
      skillArgs = spaceIdx > 0 ? payload.prompt.slice(spaceIdx + 1) : "";
      // skillArgs 含用户自由文本,脱敏后再写日志避免密钥落入 stdout。
      console.log(
        "[Skill Matching] Command:",
        command,
        "Args:",
        redactSecrets(skillArgs ?? "").text,
      );

      skill = skillRegistry.matchByCommand(command);
      console.log(
        "[Skill Matching] Found skill:",
        skill ? skill.name : "未找到",
      );

      if (!skill) {
        const cleanCommand = command.startsWith("/")
          ? command.slice(1).toLowerCase()
          : command.toLowerCase();
        const allSkills = skillRegistry.listUserVisible();
        console.log(
          "[Skill Matching] Available skills:",
          allSkills.map((s) => s.id),
        );

        const fuzzyMatch = allSkills.find(
          (s) =>
            s.id.toLowerCase().includes(cleanCommand) ||
            cleanCommand.includes(s.id.toLowerCase()) ||
            s.name.toLowerCase().includes(cleanCommand),
        );

        if (fuzzyMatch) {
          console.log("[Skill Matching] Fuzzy match found:", fuzzyMatch.name);
          skill = fuzzyMatch;
        }
      }
    }

    if (!skill) {
      skill = skillRegistry.matchByPrompt(payload.prompt);
    }

    // ── 提前转换 history,使 fork 与非 fork 路径都能使用 ──
    let convertedHistory: import("ai").ModelMessage[] | undefined;
    if (Array.isArray(payload.history) && payload.history.length > 0) {
      try {
        const coreMessages = await convertToCoreMessages(
          payload.history as HistoryMessage[],
          {
            // 用「解析后的 adapter 名」做能力查表:MiMo 常以 host 覆盖路由到
            // xiaomi adapter,而 llmConfig.provider 未必是 "xiaomi"。对其它
            // provider,resolveAdapterName 原样返回,行为不变。
            providerId: llmConfig?.provider
              ? resolveAdapterName(llmConfig.provider, llmConfig.baseUrl)
              : undefined,
          },
        );

        let compressorCalled = false;
        const compressor = async (
          msgs: import("ai").ModelMessage[],
          budget: number,
        ) => {
          compressorCalled = true;

          // 在压缩前先对超大的工具结果(>60KB)做摘要。仅当上下文确实
          // 超出预算时才运行,避免在短对话上做不必要的 LLM 调用。
          let preprocessed = msgs;
          try {
            preprocessed = await summarizeLargeToolResults(msgs, {
              model,
              signal: controller.signal,
              taskId: id,
              promptSnippet: payload.prompt,
            });
          } catch (err) {
            console.warn(
              "[ai:executeTask] Tool result summarization failed, continuing with raw results:",
              err instanceof Error ? err.message : err,
            );
          }

          const result = await compressContext(preprocessed, {
            model,
            budget,
            signal: controller.signal,
            taskId: id,
            promptSnippet: payload.prompt,
          });
          // 通过 IPC 转发给渲染层(compressContext 已写入 store)
          if (!sender.isDestroyed()) {
            const eventType = result.hadError
              ? "compression-error"
              : result.wasCompressed
                ? "compression-write"
                : "compression-skip";
            sender.send("ai:memory-event", {
              taskId: id,
              type: eventType,
              promptSnippet: payload.prompt?.slice(0, 80),
              detail: result.wasCompressed
                ? {
                    originalTokens: result.originalTokens,
                    compressedTokens: result.compressedTokens,
                    summaryTokens: result.summaryTokens,
                  }
                : { originalTokens: result.originalTokens },
            });
          }
          return result;
        };
        const tokenBudget = llmConfig?.model
          ? getTokenBudgetForModel(llmConfig.model)
          : undefined;
        const originalTokens = estimateTokens(coreMessages);
        const truncationResult = await truncateToFitAsync(
          coreMessages,
          tokenBudget,
          compressor,
        );
        convertedHistory = truncationResult.messages;

        emitTaskTraceEvent(sender, {
          taskId: id,
          type: "context-budget",
          timestamp: new Date().toISOString(),
          detail: {
            tokenBudget: tokenBudget ?? null,
            originalTokens,
            wasTruncated: truncationResult.wasTruncated,
            messagesDropped: truncationResult.messagesDropped,
          },
        });

        // 记录消息被简单截断悄然丢弃的情形
        if (truncationResult.messagesDropped > 0 && !sender.isDestroyed()) {
          emitMemoryEvent(
            sender,
            id,
            "truncation-drop",
            {
              messagesDropped: truncationResult.messagesDropped,
              originalTokens,
            },
            payload.prompt,
          );
        }

        // 若 compressor 从未被调用(history 在预算内),仍发出一个
        // compression-skip 事件,让调试面板显示有活动
        if (!compressorCalled) {
          emitMemoryEvent(
            sender,
            id,
            "compression-skip",
            { originalTokens },
            payload.prompt,
          );
        }
      } catch (err) {
        console.warn(
          "[ai:executeTask] Failed to convert history, falling back to prompt mode:",
          err,
        );
      }
    }

    // ── Skill 预处理与执行模式 ──
    let skillPrompt = "";
    if (skill) {
      if (!sender.isDestroyed()) {
        sender.send("ai:skill-activated", {
          id,
          skillId: skill.id,
          skillName: skill.name,
          source: skill.external?.source?.type ?? "built-in",
        });
      }

      emitTaskTraceEvent(sender, {
        taskId: id,
        type: "skill-activated",
        timestamp: new Date().toISOString(),
        detail: {
          skillId: skill.id,
          skillName: skill.name,
          source: skill.external?.source?.type ?? "built-in",
          isExplicitSkillCommand,
        },
      });

      const trustLevel = skill.external
        ? getTrustLevel(skill.external.source.type)
        : "high";

      const preprocessed = await preprocessSkill(
        skill.external?.body ?? skill.systemPrompt,
        skillArgs,
        legacyWorkspacePath,
        {
          sourcePath: skill.external?.sourcePath,
          trustLevel,
        },
      );

      if (skill.external?.frontmatter.context === "fork") {
        const runSubagent = createForkSkillRunner({
          sender,
          taskId: id,
          parentSignal: controller.signal,
          workspacePath: legacyWorkspacePath,
          llmConfigId: payload.llmConfigId,
        });
        const deps: ExecutorDeps = { runSubagent };

        await executeSkill(
          {
            skill,
            processedPrompt: preprocessed.systemPrompt,
            systemPrompt: payload.prompt,
            workspacePath: legacyWorkspacePath,
            sender,
            taskId: id,
            abortSignal: controller.signal,
            injectionMode: "eager",
            history: convertedHistory,
          },
          deps,
        );

        updateTask(id, {
          status: "completed",
          result: "",
          completedAt: new Date().toISOString(),
        });
        if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
        return { id, status: "completed" };
      }

      const source = skill.external?.sourcePath ?? skill.name;
      skillPrompt = `\n\n${wrapWithSecurityBoundary(preprocessed.systemPrompt, source)}`;
    }

    const allowedTools = skill?.external?.frontmatter["allowed-tools"];
    if (allowedTools) {
      console.log(
        `[Tool Registry] Using restricted tool set for ${skill?.name}:`,
        allowedTools,
      );
    } else {
      console.log(
        `[Tool Registry] Using full tool set (no restrictions for ${skill?.name || "no skill"})`,
      );
    }
    const skillTools = skill?.tools ?? {};

    // ── 从 history 构建消息(若可用) ──
    const useMessagesMode = (convertedHistory?.length ?? 0) > 0;

    // ── AgentLoop 驱动 + IPC 转译 ──────────────────────────
    const providerOptions = adapter.buildProviderOptions();

    // Watchdog 贯穿整个 agent 运行过程。
    const watchdog = new StreamWatchdog({
      taskId: id,
      sender,
      abortController: controller,
    });
    watchdog.start();

    // 把文本 delta 合并进 30ms 窗口,以抑制渲染层的重渲染。
    const deltaBatcher = new DeltaBatcher({
      flush: (text) => {
        if (!sender.isDestroyed()) {
          sender.send("ai:stream-delta", { id, delta: text });
        }
      },
    });

    let fullText = "";
    let agentInputTokens: number | null = null;
    let agentOutputTokens: number | null = null;
    let agentTotalTokens: number | null = null;
    let agentProviderMeta: Record<string, unknown> | undefined;

    const workspace =
      ref.kind === "local"
        ? new LocalWorkspace(ref.path)
        : await createWorkspace(ref, requireWorkspaceFactoryDeps());

    // 对 GitHub workspace,此刻把 clone 目录登记给沙箱检查。
    if (ref.kind !== "local") {
      setTaskWorkspace(id, workspace.root);
    }

    // 每个任务检测一次 workspace 是否由 git 托管。系统提示词
    // (L1 git 原则)与工具 registry(嵌入 `runCommand` 描述的 L2 git
    // 协议)都会用到。参见 `system-prompt.buildGitPrinciples` /
    // `buildGitRunCommandProtocol`。
    const isGitWorkspace = isGitBackedWorkspace(workspace);

    // 读取工作目录记忆（AGENTS.md / CLAUDE.md），注入系统提示词，
    // 让 Agent 复用已知事实、避免重复探索目录。
    const workspaceMemory = await readWorkspaceMemory(workspace);

    const systemPrompt =
      buildAgentSystemPrompt({
        workspacePath: legacyWorkspacePath,
        skill,
        skillArgs,
        isExplicitSkillCommand,
        modelName: llmConfig?.model,
        isGitWorkspace,
        workspaceMemory,
      }) + skillPrompt;

    console.log(
      `[System Prompt] Generated for skill ${skill?.name || "none"}:`,
      systemPrompt.substring(0, 200),
    );

    // ── 构建按任务隔离的 ToolRegistry,并与 skill 专属工具合并 ──
    // Registry 工具(文件操作 + askClarification)会经过 beforeToolCall
    // 审批 hook。skill 自带的工具(如 pdf-processor)是预先构建好的
    // ai-sdk Tool 对象,合并时不加守卫。
    const toolRegistry = buildAgentToolRegistry({
      sender,
      taskId: id,
      allowedTools,
      modelName: llmConfig?.model,
      isGitWorkspace,
    });
    const beforeToolCall = buildApprovalHook({
      sender,
      taskId: id,
      workspace,
    });
    const registryTools = toolRegistry.toAiSdkTools({
      ctxFactory: ({ toolCallId }) => ({
        workspace,
        signal: controller.signal,
        toolCallId,
      }),
      beforeToolCall,
      // 当此任务的草稿计划在等待审批时,阻塞任何工具;无计划待审时
      // 立即解决。
      planGate: async () => {
        const gate = awaitPlanGate(id);
        return gate ? await gate : true;
      },
    });
    const agentTools = { ...registryTools, ...skillTools };

    // 默认:在每个任务上附加零 LLM 的规则层(pdfParseFailure +
    // toolDeniedSequence)。当 skill 通过 `reflect: true` 选用时
    // —— 无论是经 SKILL.md frontmatter(外部 skill)还是经内置 TS skill
    // 的 `reflect` 字段 —— 我们在其之上再加 `emptyAssistantWithTools`
    // + LLM 裁决。
    const reflectOptIn =
      skill?.external?.frontmatter.reflect === true || skill?.reflect === true;
    const reflectHook = createReflectionGate(
      reflectOptIn
        ? { model, rules: builtinRules() }
        : { rules: defaultRules() },
    );

    const agentLoop = new AgentLoop({
      workspace,
      model,
      tools: agentTools,
      systemPrompt,
      history: useMessagesMode ? convertedHistory : undefined,
      providerOptions,
      signal: controller.signal,
      agentId: id,
      hooks: { reflect: reflectHook },
      classifyError: (err): ClassifiedRetryError => {
        const c = classifyError(err);
        return {
          type: c.type,
          retryable: c.retryable,
          maxRetries: c.maxRetries,
          backoffMs: c.backoffMs,
        };
      },
    });

    const promptForLoop = useMessagesMode ? payload.prompt : payload.prompt;
    // 当 useMessagesMode 为 false 时,我们仍传入用户 prompt —— AgentLoop
    // 会把它追加到 history(此时 history 为空),与 M1 之前的单次执行
    // 行为一致。

    console.log("[Main] Starting AgentLoop for taskId:", id);

    try {
      let manualStop = false;
      for await (const ev of agentLoop.run(
        promptForLoop,
      ) as AsyncIterable<AgentEvent>) {
        watchdog.activity();
        if (manualStopFlags.get(id)) {
          console.log("[Main] Manual stop flag detected for taskId:", id);
          manualStop = true;
          if (!controller.signal.aborted) controller.abort();
          // 继续 drain 事件,以便观察到 agent_end。
        }
        // 注意:不要因 sender 销毁(关窗)就 break 终止任务 —— 否则关窗会杀掉
        // 仍想后台继续、并在重开后重连的任务。各发送点已用 isDestroyed 守卫跳过
        // 死 sender;重开后 ai:reattachTask 把投递目标重定向到新窗口即恢复。
        // 任务始终 drain 到 agent_end 自然结束,再由 finally 的 cleanupTask 清理。

        switch (ev.type) {
          case "agent_start":
            // ai:stream-start 已在上面发出(与 M1 之前保持一致)。
            break;
          case "message_update":
            fullText += ev.deltaText;
            deltaBatcher.push(ev.deltaText);
            break;
          case "reasoning_update":
            // 推理 delta 通常比文本 delta 慢(模型边思考边发出)。
            // 不做批处理 —— 它们本来就已经够粗。
            if (!sender.isDestroyed()) {
              sender.send("ai:stream-reasoning", {
                id,
                messageId: ev.messageId,
                delta: ev.deltaText,
              });
            }
            break;
          case "reasoning_end":
            if (!sender.isDestroyed()) {
              sender.send("ai:stream-reasoning-end", {
                id,
                messageId: ev.messageId,
              });
            }
            break;
          case "tool_execution_start": {
            deltaBatcher.drain();
            const previewSnapshot = consumePreview(ev.toolCallId);
            sender.send("ai:stream-tool-call", {
              id,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              args: ev.args,
              previewSnapshot,
            });
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: "tool-start",
              timestamp: new Date().toISOString(),
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              detail: {},
            });
            break;
          }
          case "tool_execution_end":
            sender.send("ai:stream-tool-result", {
              id,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              result: ev.result,
            });
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: ev.success ? "tool-end" : "tool-error",
              timestamp: new Date().toISOString(),
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              detail: { ok: ev.success, durationMs: ev.durationMs },
            });
            break;
          case "retry": {
            console.log(
              `[Main] Retry attempt ${ev.attempt} for taskId: ${id}, error type: ${ev.errorType}`,
            );
            fullText = "";
            // 从一次新的分类中取得 maxRetries(仅用于信息展示)。
            const retryInfo = classifyError(new Error(ev.errorType));
            if (!sender.isDestroyed()) {
              sender.send("ai:stream-retry", {
                id,
                attempt: ev.attempt,
                type: ev.errorType,
                maxRetries: retryInfo.maxRetries,
              });
            }
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: "retry",
              timestamp: new Date().toISOString(),
              detail: {
                attempt: ev.attempt,
                errorType: ev.errorType,
                maxRetries: retryInfo.maxRetries,
              },
            });
            break;
          }
          case "agent_end": {
            deltaBatcher.drain();
            agentInputTokens = ev.totalUsage?.inputTokens ?? null;
            agentOutputTokens = ev.totalUsage?.outputTokens ?? null;
            agentTotalTokens = ev.totalUsage?.totalTokens ?? null;
            agentProviderMeta = ev.providerMetadata;
            // 若存在,使用 AgentLoop 累积的 finalText(重试后比我们自己
            // 的累加值更准确)。
            if (typeof ev.finalText === "string") {
              fullText = ev.finalText;
            }

            if (ev.status === "failed") {
              const cls = classifyError(
                new Error(ev.error?.message ?? "Unknown error"),
              );
              const errorMsg =
                cls.userMessage || ev.error?.message || "Unknown error";
              updateTask(id, {
                status: "failed",
                result: errorMsg,
                completedAt: new Date().toISOString(),
              });
              emitTaskTraceEvent(sender, {
                taskId: id,
                type: "task-failed",
                timestamp: new Date().toISOString(),
                detail: {
                  status: "failed",
                  errorType: cls.type,
                  message: errorMsg,
                },
              });
              if (!sender.isDestroyed()) {
                sender.send("ai:stream-error", {
                  id,
                  error: errorMsg,
                  type: cls.type,
                  recoveryActions: cls.recoveryActions,
                });
              }
              void appendPattern({
                kind: "task",
                ts: new Date().toISOString(),
                taskId: id,
                status: "failed",
                totalUsage: ev.totalUsage,
                durationMs: Date.now() - taskStartMs,
              });
              return { id, status: "failed", message: errorMsg };
            }

            // status 为 "completed" 或 "cancelled" —— 两者都收尾为
            // completed,以保持 IPC 一致(M1 之前的路径在中止时也会调用
            // ai:stream-done)。
            const wasCancelled = ev.status === "cancelled" || manualStop;
            updateTask(id, {
              status: "completed",
              result: fullText,
              completedAt: new Date().toISOString(),
              modelId: llmConfig?.model ?? null,
              provider: llmConfig?.provider ?? null,
              inputTokens: agentInputTokens,
              outputTokens: agentOutputTokens,
              totalTokens: agentTotalTokens,
            });
            // 通过 provider adapter 处理缓存事件
            try {
              const { cacheWriteTokens: cw, cacheReadTokens: cr } =
                adapter.extractCacheMetrics(agentProviderMeta);
              if (cw && cw > 0) {
                emitMemoryEvent(
                  sender,
                  id,
                  "cache-write",
                  { cacheWriteTokens: cw },
                  payload.prompt,
                );
              }
              if (cr && cr > 0) {
                emitMemoryEvent(
                  sender,
                  id,
                  "cache-hit",
                  { cacheReadTokens: cr },
                  payload.prompt,
                );
              }
            } catch {
              // 非关键
            }
            emitTaskTraceEvent(sender, {
              taskId: id,
              type: wasCancelled ? "task-aborted" : "task-done",
              timestamp: new Date().toISOString(),
              detail: {
                status: "completed",
                inputTokens: agentInputTokens,
                outputTokens: agentOutputTokens,
                totalTokens: agentTotalTokens,
              },
            });
            void appendPattern({
              kind: "task",
              ts: new Date().toISOString(),
              taskId: id,
              status: wasCancelled ? "cancelled" : "completed",
              totalUsage: ev.totalUsage,
              durationMs: Date.now() - taskStartMs,
            });
            if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
            return { id, status: "completed" };
          }
        }
      }

      // 迭代器耗尽但未出现 agent_end(例如 sender 被销毁)—— 尽力清理。
      updateTask(id, {
        status: "completed",
        result: fullText,
        completedAt: new Date().toISOString(),
      });
      if (!sender.isDestroyed()) sender.send("ai:stream-done", { id });
      return { id, status: "completed" };
    } finally {
      deltaBatcher.drain();
      watchdog.stop();
    }
  } catch (error: unknown) {
    const classified = classifyError(error);
    const errorMsg =
      classified.userMessage ||
      (error instanceof Error ? error.message : "Unknown error");

    updateTask(id, {
      status: "failed",
      result: errorMsg,
      completedAt: new Date().toISOString(),
    });

    emitTaskTraceEvent(sender, {
      taskId: id,
      type: "task-failed",
      timestamp: new Date().toISOString(),
      detail: {
        status: "failed",
        errorType: classified.type,
        message: errorMsg,
      },
    });

    if (!sender.isDestroyed()) {
      sender.send("ai:stream-error", {
        id,
        error: errorMsg,
        type: classified.type,
        recoveryActions: classified.recoveryActions,
      });
    }
    return { id, status: "failed", message: errorMsg };
  } finally {
    // 确保 controller 始终被清理,即使错误发生在内层 try 块之前
    // (例如在 getModelAndAdapterByConfigId、convertToCoreMessages
    // 或 truncateToFitAsync 中)。
    cleanupTask(id);
  }
};

/**
 * 注册所有 AI 相关的 IPC handler
 */
export const registerAIHandlers = () => {
  ipcMain.handle(
    "ai:approveToolCall",
    async (_event, payload: { toolCallId: string; approved: boolean }) => {
      const resolve = pendingApprovals.get(payload.toolCallId);
      if (resolve) {
        resolve(payload.approved);
        pendingApprovals.delete(payload.toolCallId);
        toolCallToTaskMap.delete(payload.toolCallId);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    "ai:approveToolCallBatch",
    async (
      _event,
      payload: { batchId: string; approved: boolean; remember?: boolean },
    ) => {
      const settled = settleBatch(
        payload.batchId,
        payload.approved,
        payload.remember ?? false,
      );
      return { ok: settled };
    },
  );

  ipcMain.handle(
    "ai:stopGeneration",
    async (_event, payload: { taskId: string }) => {
      console.log("[Main] Stop generation request for taskId:", payload.taskId);
      const stopped = stopTaskExecution(payload.taskId);
      return { ok: true, stopped };
    },
  );

  ipcMain.handle("ai:getConfig", async () => {
    return {
      provider:
        process.env.AI_PROVIDER || getSetting("ai_provider") || "openai",
      model: process.env.AI_MODEL || getSetting("ai_model") || "gpt-4o-mini",
    };
  });

  ipcMain.handle("ai:getSkills", async () => {
    return skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      suggestions: s.suggestions ?? [],
    }));
  });

  ipcMain.handle("ai:listSkills", async () => {
    return skillRegistry.listUserVisible().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.external?.source?.type ?? "built-in",
      category: s.category ?? "tool",
      keywords: s.keywords ?? [],
      suggestions: s.suggestions ?? [],
      isExternal: !!s.external,
      external: s.external
        ? {
            context: s.external.frontmatter.context ?? "default",
            allowedTools: s.external.frontmatter["allowed-tools"] ?? [],
            userInvocable: s.external.frontmatter["user-invocable"] !== false,
            disableModelInvocation:
              s.external.frontmatter["disable-model-invocation"] === true,
            requires: s.external.frontmatter.requires,
            hasHooks: !!(
              s.external.frontmatter.hooks?.["pre-activate"] ||
              s.external.frontmatter.hooks?.["post-complete"]
            ),
            sourcePath: s.external.sourcePath,
          }
        : undefined,
    }));
  });

  ipcMain.handle(
    "ai:getSkillDetail",
    async (_event, payload: { skillId: string }) => {
      const skill = skillRegistry.getById(payload.skillId);
      if (skill) {
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.external?.source?.type ?? "built-in",
          category: skill.category ?? "tool",
          keywords: skill.keywords ?? [],
          suggestions: skill.suggestions ?? [],
          systemPrompt: skill.external ? undefined : skill.systemPrompt,
          isExternal: !!skill.external,
          enabled: true,
          eligible: true,
          external: skill.external
            ? {
                context: skill.external.frontmatter.context ?? "default",
                allowedTools: skill.external.frontmatter["allowed-tools"] ?? [],
                userInvocable:
                  skill.external.frontmatter["user-invocable"] !== false,
                disableModelInvocation:
                  skill.external.frontmatter["disable-model-invocation"] ===
                  true,
                requires: skill.external.frontmatter.requires,
                hasHooks: !!(
                  skill.external.frontmatter.hooks?.["pre-activate"] ||
                  skill.external.frontmatter.hooks?.["post-complete"]
                ),
                sourcePath: skill.external.sourcePath,
                body: skill.external.body,
              }
            : undefined,
        };
      }

      // 回落:skill 已被发现但未注册(例如已禁用的 personal/additional
      // skill)。渲染其元数据,让用户能够预览该 skill 并就地选择启用它。
      const discovered = skillRegistry.getDiscovered(payload.skillId);
      if (!discovered) return null;
      const fm = discovered.parsed.frontmatter;
      return {
        id: discovered.skillId,
        name: fm.name ?? discovered.skillId,
        description: fm.description ?? "",
        source: discovered.source.type,
        category: "tool" as const,
        keywords: [],
        suggestions: [],
        systemPrompt: undefined,
        isExternal: true,
        enabled: false,
        eligible: discovered.eligible,
        ineligibleReason: discovered.ineligibleReason,
        external: {
          context: fm.context ?? "default",
          allowedTools: fm["allowed-tools"] ?? [],
          userInvocable: fm["user-invocable"] !== false,
          disableModelInvocation: fm["disable-model-invocation"] === true,
          requires: fm.requires,
          hasHooks: !!(
            fm.hooks?.["pre-activate"] || fm.hooks?.["post-complete"]
          ),
          sourcePath: discovered.parsed.sourcePath,
          body: discovered.parsed.body,
        },
      };
    },
  );

  ipcMain.handle(
    "ai:initSkills",
    async (
      _event,
      payload: { workspacePath: string; additionalDirs?: string[] },
    ) => {
      try {
        const count = await initSkillDiscovery(
          skillRegistry,
          payload.workspacePath,
          payload.additionalDirs,
        );
        return { ok: true, registered: count };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[ai:initSkills] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "ai:refreshSkills",
    async (_event, payload: { workspacePath: string }) => {
      try {
        await skillRegistry.refreshProjectSkills(payload.workspacePath);
        return { ok: true };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[ai:refreshSkills] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );

  // Skills 弹窗:完整清单,包含按来源禁用及不合格的条目。内置 skill
  // 以「始终启用」的形式合并进来。
  ipcMain.handle("ai:listAllSkills", async () => {
    const builtIns = skillRegistry.listAll().filter((s) => !s.external);
    const builtInItems = builtIns.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: "built-in" as const,
      category: s.category ?? "tool",
      keywords: s.keywords ?? [],
      suggestions: s.suggestions ?? [],
      isExternal: false,
      enabled: true,
      eligible: true,
      external: undefined,
    }));

    const externalItems = skillRegistry.listAllDiscovered().map((d) => {
      const fm = d.frontmatter;
      const userInvocable = fm["user-invocable"] !== false;
      return {
        id: d.skillId,
        name: d.name,
        description: d.description,
        source: d.source.type,
        category: "tool" as const,
        keywords: [],
        suggestions: [],
        isExternal: true,
        enabled: d.enabled,
        eligible: d.eligible,
        ineligibleReason: d.ineligibleReason,
        external: {
          context: fm.context ?? "default",
          allowedTools: fm["allowed-tools"] ?? [],
          userInvocable,
          disableModelInvocation: fm["disable-model-invocation"] === true,
          requires: fm.requires,
          hasHooks: !!(
            fm.hooks?.["pre-activate"] || fm.hooks?.["post-complete"]
          ),
          sourcePath: d.sourcePath,
        },
      };
    });

    // 过滤掉不可由用户调用的外部 skill,使弹窗在可调用性上与既有的
    // listUserVisible() 约定一致。
    return [
      ...builtInItems,
      ...externalItems.filter((s) => s.external?.userInvocable !== false),
    ];
  });

  ipcMain.handle(
    "ai:setSkillEnabled",
    async (_event, payload: { skillId: string; enabled: boolean }) => {
      try {
        const inventory = skillRegistry.listAllDiscovered();
        const entry = inventory.find((d) => d.skillId === payload.skillId);
        if (!entry) {
          return { ok: false, error: `Unknown skill: ${payload.skillId}` };
        }
        if (
          entry.source.type !== "personal" &&
          entry.source.type !== "additional"
        ) {
          return {
            ok: false,
            error: `Only personal and additional skills can be toggled (source: ${entry.source.type})`,
          };
        }

        skillRegistry.setSkillEnabled(payload.skillId, payload.enabled);

        // 以 JSON 编码的 skill ID 数组形式持久化 allow-list。
        const ids = skillRegistry.getEnabledSkillIds();
        setSetting("skills.enabled-ids", JSON.stringify(ids));

        return { ok: true };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("[ai:setSkillEnabled] Failed:", msg);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle("ai:getSuggestions", async () => {
    return getAllSuggestions();
  });

  // devtools:把整个任务执行包进同一个 devtools run —— 主循环、结果摘要、上下文
  // 压缩、重试创建的所有模型共享同一个 middleware,工具调用不再被拆散到多个 run。
  const handleTaskExecution: typeof handleTaskExecutionInner = (
    event,
    payload,
  ) => runWithDevtoolsTaskScope(() => handleTaskExecutionInner(event, payload));
  ipcMain.handle("ai:executeTask", handleTaskExecution);

  // 重连查询:渲染层刷新后据 sessionId 问「这个会话当前有没有在跑的任务」。
  // 有则返回 { taskId, assistantMessageId },渲染层据此重新挂上并续接后续流。
  ipcMain.handle("ai:getActiveTask", (_event, sessionId?: string) =>
    sessionId ? getActiveTaskForSession(sessionId) : null,
  );

  // 重连:先把任务已录制的事件按序「重放」给发起调用的新窗口(渲染层用同一套
  // handler 重建消息,零缺口),再把后续流的投递目标重定向到该窗口。重放直接发往
  // event.sender(不经录制包装器,故不会二次录制);两步同步执行,其间 agent loop
  // 无法插入新发送,因此重放快照[0..N] 与后续 live[N+1..] 严丝合缝、不重不漏。
  ipcMain.handle("ai:reattachTask", (event, taskId?: string) => {
    if (!taskId) return false;
    const target = event.sender;
    if (!target.isDestroyed()) {
      for (const e of getTaskEvents(taskId)) {
        // 跳过「已解决」的澄清请求 —— 它的答案存在持久化的 part(answeredOption)上、
        // 不作为流事件回传,故重放会把已答问题重现成可再次点击的待答卡。仍挂起的
        // 澄清(clarificationId 还在 pending 表里)才需要重放,让用户看到并作答。
        if (e.channel === "ai:stream-clarification") {
          const cid = (e.payload as { clarificationId?: string })
            ?.clarificationId;
          if (!cid || !pendingClarifications.has(cid)) continue;
        }
        target.send(e.channel, e.payload);
      }
    }
    return redirectActiveTask(taskId, target);
  });

  /**
   * 用用户的回复来解决一个挂起的 askClarification。渲染层把按钮点击
   * 按调用级的 `clarificationId`(而非 taskId —— 并发澄清可以共存)
   * 路由到这里。当没有匹配的挂起被登记时返回 `{ok:false}`,这样渲染层
   * 可对陈旧的 part 回落到一次全新的聊天回合(例如跨应用重启而持久化
   * 下来的澄清)。
   */
  ipcMain.handle(
    "ai:answerClarification",
    (_event, payload: unknown): { ok: boolean } => {
      // 渲染层 payload 跨越不可信边界 —— typeof 守卫可防止行为异常的
      // 调用方破坏挂起的工具结果。
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as { clarificationId?: unknown }).clarificationId !==
          "string" ||
        typeof (payload as { answer?: unknown }).answer !== "string"
      ) {
        return { ok: false };
      }
      const { clarificationId, answer } = payload as {
        clarificationId: string;
        answer: string;
      };
      const drained = drainClarificationResolver(clarificationId, answer);
      return { ok: drained };
    },
  );

  registerPlanHandlers();

  registerUsageHandlers();

  registerMemoryDebugHandlers();
  registerWorkspaceMemoryHandlers();
};
