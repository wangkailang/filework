import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { TrashEntry } from "../main/core/agent/tools/trash";
import type { NativeSearchOptions, NativeSearchResult } from "../main/native";
import type { CredentialKind } from "../shared/credentials";

/** 工作目录记忆的单条结构化条目(与主进程 MemoryEntry 同形)。 */
type WorkspaceMemoryEntry = {
  key: string;
  category: "preference" | "project" | "convention" | "reference";
  text: string;
  updatedAt: string;
};

type AutomationType = "thread" | "standalone" | "project";
type AutomationScheduleKind = "interval" | "daily" | "weekly" | "cron";
type AutomationRunMode = "local" | "worktree";
type AutomationRunStatus =
  | "queued"
  | "running"
  | "needs_action"
  | "succeeded"
  | "failed"
  | "canceled";
type AutomationRunTriageStatus = "open" | "handled";

type AutomationRecord = {
  id: string;
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled: boolean;
  threadId: string | null;
  workspacePaths: string[] | null;
  runMode: AutomationRunMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AutomationRunRecord = {
  id: string;
  automationId: string;
  automationTitle: string;
  trigger: "manual" | "scheduled";
  status: AutomationRunStatus;
  triageStatus: AutomationRunTriageStatus;
  needsActionReason: string | null;
  chatSessionId: string | null;
  assistantMessageId: string | null;
  taskId: string | null;
  prompt: string;
  workspacePaths: string[] | null;
  threadId: string | null;
  modelId: string | null;
  output: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type AutomationCreatePayload = {
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled?: boolean;
  threadId?: string | null;
  workspacePaths?: string[] | null;
  runMode?: AutomationRunMode | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
};

/**
 * 通过 contextBridge 向渲染进程暴露安全的 IPC 方法。
 * 这是主进程与渲染进程之间的唯一桥梁。
 */
const api = {
  // 对话框
  openDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke("dialog:openDirectory", defaultPath),
  openFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:openFiles"),
  showInFinder: (path: string) =>
    ipcRenderer.invoke("shell:showInFinder", path),
  openFilesAndFoldersSettings: () =>
    ipcRenderer.invoke("shell:openFilesAndFoldersSettings"),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("shell:openExternal", url),

  // 文件系统
  listDirectory: (path: string, depth?: number) =>
    ipcRenderer.invoke("fs:listDirectory", path, depth),
  readFile: (path: string) => ipcRenderer.invoke("fs:readFile", path),
  // 文件预览专用:对超大文件截断读取(>10MB 只取前 10MB)。
  readFilePreview: (
    path: string,
  ): Promise<{ content: string; truncated: boolean; totalBytes: number }> =>
    ipcRenderer.invoke("fs:readFilePreview", path),
  directoryStats: (path: string) =>
    ipcRenderer.invoke("fs:directoryStats", path),
  // native 加速的文件检索(按名字/路径词元 + 元数据过滤)。
  searchFiles: (
    workspaceRoot: string,
    query: string,
    options?: NativeSearchOptions,
  ): Promise<NativeSearchResult> =>
    ipcRenderer.invoke("fs:searchFiles", workspaceRoot, query, options),

  // 回收站
  trashList: (workspaceRoot: string): Promise<TrashEntry[]> =>
    ipcRenderer.invoke("trash:list", workspaceRoot),
  trashRestore: (
    workspaceRoot: string,
    id: string,
  ): Promise<{ restoredTo: string }> =>
    ipcRenderer.invoke("trash:restore", workspaceRoot, id),
  trashEmpty: (
    workspaceRoot: string,
    id?: string,
  ): Promise<{ removed: number }> =>
    ipcRenderer.invoke("trash:empty", workspaceRoot, id),

  /**
   * 拖拽辅助:解析从 `DataTransfer.files` 取出的 `File` 对象的绝对文件系统路径。
   * Electron 32+ 移除了 `File` 上的 `path` 属性;`webUtils.getPathForFile`
   * 是官方推荐的替代方案,且必须运行在 preload 中(由于 `File` 无法序列化,
   * 不能将其暴露为普通的 IPC 通道)。
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // 聊天附件
  chatAttachFile: (payload: {
    sessionId: string;
    sourcePath: string;
    originalName?: string;
  }) => ipcRenderer.invoke("chat:attachFile", payload),
  chatAttachBlob: (payload: {
    sessionId: string;
    bytes: Uint8Array;
    mimeType: string;
    name?: string;
  }) => ipcRenderer.invoke("chat:attachBlob", payload),

  // AI
  getAIConfig: () => ipcRenderer.invoke("ai:getConfig"),
  getSkills: () => ipcRenderer.invoke("ai:getSkills"),
  getSuggestions: () => ipcRenderer.invoke("ai:getSuggestions"),
  listSkills: () => ipcRenderer.invoke("ai:listSkills"),
  listAllSkills: () => ipcRenderer.invoke("ai:listAllSkills"),
  setSkillEnabled: (skillId: string, enabled: boolean) =>
    ipcRenderer.invoke("ai:setSkillEnabled", { skillId, enabled }),
  getSkillDetail: (skillId: string) =>
    ipcRenderer.invoke("ai:getSkillDetail", { skillId }),
  initSkills: (payload: { workspacePath: string; additionalDirs?: string[] }) =>
    ipcRenderer.invoke("ai:initSkills", payload),
  refreshSkills: (workspacePath: string) =>
    ipcRenderer.invoke("ai:refreshSkills", { workspacePath }),
  // Skills 市场:列表 / 安装 / 卸载
  marketList: (): Promise<unknown> => ipcRenderer.invoke("market:list"),
  marketInstall: (entry: unknown): Promise<unknown> =>
    ipcRenderer.invoke("market:install", { entry }),
  marketUninstall: (skillId: string): Promise<unknown> =>
    ipcRenderer.invoke("market:uninstall", { skillId }),
  approveSkill: (payload: { skillId: string; approved: boolean }) =>
    ipcRenderer.invoke("ai:approveSkill", payload),
  executeTask: (payload: {
    prompt: string;
    /** 编码后的 WorkspaceRef(首选)。缺省时回落到 workspacePath。 */
    workspaceRefJson?: string;
    /** 旧版:绝对路径。等价于 `{kind:"local", path}`。 */
    workspacePath?: string;
    /** 聊天会话 id —— 决定 github 自动分支的作用域。 */
    sessionId?: string;
    /** 本回合助手消息 id;登记进重连表,刷新后据此重挂。 */
    assistantMessageId?: string;
    automationRunId?: string;
    llmConfigId?: string;
    history?: Array<{
      role: "user" | "assistant";
      content: string;
      parts?: unknown[];
    }>;
  }) => ipcRenderer.invoke("ai:executeTask", payload),
  /** 刷新后查询某会话当前是否有在跑的任务,用于重连续流。 */
  getActiveTask: (
    sessionId: string,
  ): Promise<{
    taskId: string;
    sessionId?: string;
    assistantMessageId?: string;
  } | null> => ipcRenderer.invoke("ai:getActiveTask", sessionId),
  getActiveTasks: (): Promise<
    Array<{
      taskId: string;
      sessionId?: string;
      assistantMessageId?: string;
    }>
  > => ipcRenderer.invoke("ai:getActiveTasks"),
  /** 重连:把任务的流重定向到当前窗口(关窗重开 → 新 webContents)。 */
  reattachTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke("ai:reattachTask", taskId),
  stopGeneration: (taskId: string) =>
    ipcRenderer.invoke("ai:stopGeneration", { taskId }),

  // 规划器
  generatePlan: (payload: {
    prompt: string;
    workspacePath: string;
    llmConfigId?: string;
  }) => ipcRenderer.invoke("ai:generatePlan", payload),
  approvePlan: (planId: string) =>
    ipcRenderer.invoke("ai:approvePlan", { planId }),
  rejectPlan: (planId: string) =>
    ipcRenderer.invoke("ai:rejectPlan", { planId }),
  cancelPlan: (planId: string) =>
    ipcRenderer.invoke("ai:cancelPlan", { planId }),

  /** 回复一个待处理的 askClarification 挂起。以 `ai:stream-clarification`
   *  中发出的每次调用的 clarificationId 为键。
   *  当不存在匹配的挂起时解析为 `{ok:false}`,从而让渲染进程
   *  对陈旧片段回落为一次新的聊天回合。 */
  answerClarification: (payload: {
    clarificationId: string;
    answer: string;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("ai:answerClarification", payload),

  // 规划器流式事件
  onPlanGenerating: (callback: (data: { prompt: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { prompt: string },
    ) => callback(data);
    ipcRenderer.on("ai:plan-generating", handler);
    return () => ipcRenderer.removeListener("ai:plan-generating", handler);
  },
  onPlanReady: (callback: (data: { id: string; plan: unknown }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; plan: unknown },
    ) => callback(data);
    ipcRenderer.on("ai:plan-ready", handler);
    return () => ipcRenderer.removeListener("ai:plan-ready", handler);
  },
  onPlanError: (callback: (data: { id: string; error: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; error: string },
    ) => callback(data);
    ipcRenderer.on("ai:plan-error", handler);
    return () => ipcRenderer.removeListener("ai:plan-error", handler);
  },
  onPlanStepStart: (
    callback: (data: {
      id: string;
      planId: string;
      stepId: number;
      totalSteps: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; planId: string; stepId: number; totalSteps: number },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-start", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-start", handler);
  },
  onPlanStepDone: (
    callback: (data: { id: string; planId: string; stepId: number }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; planId: string; stepId: number },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-done", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-done", handler);
  },
  onPlanStepError: (
    callback: (data: {
      id: string;
      planId: string;
      stepId: number;
      error: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; planId: string; stepId: number; error: string },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-error", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-error", handler);
  },
  onPlanSubStepProgress: (
    callback: (data: {
      id: string;
      planId: string;
      stepId: number;
      completed: number;
      total: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        planId: string;
        stepId: number;
        completed: number;
        total: number;
      },
    ) => callback(data);
    ipcRenderer.on("ai:plan-substep-progress", handler);
    return () =>
      ipcRenderer.removeListener("ai:plan-substep-progress", handler);
  },
  onPlanStepArtifacts: (
    callback: (data: {
      id: string;
      planId: string;
      stepId: number;
      artifacts: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        result?: unknown;
        success: boolean;
      }>;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        planId: string;
        stepId: number;
        artifacts: Array<{
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
          result?: unknown;
          success: boolean;
        }>;
      },
    ) => callback(data);
    ipcRenderer.on("ai:plan-step-artifacts", handler);
    return () => ipcRenderer.removeListener("ai:plan-step-artifacts", handler);
  },

  // Skill 事件
  onSkillActivated: (
    callback: (data: {
      id: string;
      skillId: string;
      skillName: string;
      source: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; skillId: string; skillName: string; source: string },
    ) => callback(data);
    ipcRenderer.on("ai:skill-activated", handler);
    return () => ipcRenderer.removeListener("ai:skill-activated", handler);
  },
  onSkillApprovalRequest: (
    callback: (data: {
      skillId: string;
      sourcePath: string;
      commands: string[];
      hooks: string[];
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        skillId: string;
        sourcePath: string;
        commands: string[];
        hooks: string[];
      },
    ) => callback(data);
    ipcRenderer.on("skill:approval-request", handler);
    return () => ipcRenderer.removeListener("skill:approval-request", handler);
  },

  // AI 流式事件
  onStreamStart: (
    callback: (data: {
      id: string;
      sessionId?: string;
      assistantMessageId?: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        sessionId?: string;
        assistantMessageId?: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-start", handler);
    return () => ipcRenderer.removeListener("ai:stream-start", handler);
  },
  onStreamDelta: (callback: (data: { id: string; delta: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; delta: string },
    ) => callback(data);
    ipcRenderer.on("ai:stream-delta", handler);
    return () => ipcRenderer.removeListener("ai:stream-delta", handler);
  },
  onStreamReasoning: (
    callback: (data: { id: string; messageId: string; delta: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; messageId: string; delta: string },
    ) => callback(data);
    ipcRenderer.on("ai:stream-reasoning", handler);
    return () => ipcRenderer.removeListener("ai:stream-reasoning", handler);
  },
  onStreamReasoningEnd: (
    callback: (data: { id: string; messageId: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; messageId: string },
    ) => callback(data);
    ipcRenderer.on("ai:stream-reasoning-end", handler);
    return () => ipcRenderer.removeListener("ai:stream-reasoning-end", handler);
  },
  onStreamToolCall: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      previewSnapshot?: import("../main/core/agent/preview/types").ToolPreview;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        toolCallId: string;
        toolName: string;
        args: unknown;
        previewSnapshot?: import("../main/core/agent/preview/types").ToolPreview;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-call", handler);
    return () => ipcRenderer.removeListener("ai:stream-tool-call", handler);
  },
  onStreamToolResult: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        toolCallId: string;
        toolName: string;
        result: unknown;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-result", handler);
    return () => ipcRenderer.removeListener("ai:stream-tool-result", handler);
  },

  // ── subagent(spawnSubagent fan-out)事件 ──────────────────────────
  // 全部携带 parentTaskId,渲染层据此过滤(parentTaskId === 当前主任务)
  // 并把进度挂到对应的 SubagentMessagePart 上。
  onSubagentSpawn: (
    callback: (data: {
      parentTaskId: string;
      batchId: string;
      toolCallId: string;
      concurrency: number;
      children: Array<{ childTaskId: string; goal: string }>;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        parentTaskId: string;
        batchId: string;
        toolCallId: string;
        concurrency: number;
        children: Array<{ childTaskId: string; goal: string }>;
      },
    ) => callback(data);
    ipcRenderer.on("ai:subagent-spawn", handler);
    return () => ipcRenderer.removeListener("ai:subagent-spawn", handler);
  },
  onSubagentDelta: (
    callback: (data: {
      parentTaskId: string;
      batchId: string;
      childTaskId: string;
      delta: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        parentTaskId: string;
        batchId: string;
        childTaskId: string;
        delta: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:subagent-delta", handler);
    return () => ipcRenderer.removeListener("ai:subagent-delta", handler);
  },
  onSubagentToolCall: (
    callback: (data: {
      parentTaskId: string;
      batchId: string;
      childTaskId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        parentTaskId: string;
        batchId: string;
        childTaskId: string;
        toolCallId: string;
        toolName: string;
        args: unknown;
      },
    ) => callback(data);
    ipcRenderer.on("ai:subagent-tool-call", handler);
    return () => ipcRenderer.removeListener("ai:subagent-tool-call", handler);
  },
  onSubagentToolResult: (
    callback: (data: {
      parentTaskId: string;
      batchId: string;
      childTaskId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        parentTaskId: string;
        batchId: string;
        childTaskId: string;
        toolCallId: string;
        toolName: string;
        result: unknown;
      },
    ) => callback(data);
    ipcRenderer.on("ai:subagent-tool-result", handler);
    return () => ipcRenderer.removeListener("ai:subagent-tool-result", handler);
  },
  onSubagentChildUsage: (
    callback: (data: {
      parentTaskId: string;
      batchId: string;
      childTaskId: string;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
        totalTokens?: number | null;
      };
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        parentTaskId: string;
        batchId: string;
        childTaskId: string;
        usage?: {
          inputTokens?: number | null;
          outputTokens?: number | null;
          totalTokens?: number | null;
        };
      },
    ) => callback(data);
    ipcRenderer.on("ai:subagent-child-usage", handler);
    return () => ipcRenderer.removeListener("ai:subagent-child-usage", handler);
  },
  onSubagentReport: (
    callback: (data: {
      parentTaskId: string;
      batchId: string;
      childTaskId: string;
      report: import("../main/core/agent/sub-agent-contract").SubAgentReport;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        parentTaskId: string;
        batchId: string;
        childTaskId: string;
        report: import("../main/core/agent/sub-agent-contract").SubAgentReport;
      },
    ) => callback(data);
    ipcRenderer.on("ai:subagent-report", handler);
    return () => ipcRenderer.removeListener("ai:subagent-report", handler);
  },
  onStreamToolApproval: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      description: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        toolCallId: string;
        toolName: string;
        args: unknown;
        description: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-approval", handler);
    return () => ipcRenderer.removeListener("ai:stream-tool-approval", handler);
  },
  /** M12:被跟踪的运行完成时触发的 CI watcher 事件。 */
  onCiRunDone: (
    callback: (data: {
      id: string;
      runId: string;
      workspaceId: string;
      conclusion: string | null;
      url: string;
      name: string;
      durationSec: number | null;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        runId: string;
        workspaceId: string;
        conclusion: string | null;
        url: string;
        name: string;
        durationSec: number | null;
      },
    ) => callback(data);
    ipcRenderer.on("ai:ci-run-done", handler);
    return () => ipcRenderer.removeListener("ai:ci-run-done", handler);
  },
  /** M12:被跟踪的运行在 TIMEOUT_MS 内未完成时触发的 CI watcher 事件。 */
  onCiRunTimeout: (
    callback: (data: {
      id: string;
      runId: string;
      workspaceId: string;
      elapsedMs: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        runId: string;
        workspaceId: string;
        elapsedMs: number;
      },
    ) => callback(data);
    ipcRenderer.on("ai:ci-run-timeout", handler);
    return () => ipcRenderer.removeListener("ai:ci-run-timeout", handler);
  },
  /**
   * M13:当 subscribeAfterDispatch 在一次 workflow_dispatch 后(重试 3 次 ×2 秒)
   * 仍找不到新的 runId 时触发的 CI watcher 事件。会在聊天中给出友好的
   * "manually run listCIRuns" 提示。
   */
  onCiDispatchResolveFailed: (
    callback: (data: {
      id: string;
      workspaceId: string;
      ref: string;
      workflowFile: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        workspaceId: string;
        ref: string;
        workflowFile: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:ci-dispatch-resolve-failed", handler);
    return () =>
      ipcRenderer.removeListener("ai:ci-dispatch-resolve-failed", handler);
  },
  approveToolCall: (toolCallId: string, approved: boolean) =>
    ipcRenderer.invoke("ai:approveToolCall", { toolCallId, approved }),
  onStreamToolBatchApproval: (
    callback: (data: {
      id: string;
      batchId: string;
      toolName: string;
      entries: Array<{
        toolCallId: string;
        args: unknown;
        description: string;
        preview?: import("../main/core/agent/preview/types").ToolPreview;
      }>;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        batchId: string;
        toolName: string;
        entries: Array<{
          toolCallId: string;
          args: unknown;
          description: string;
          preview?: import("../main/core/agent/preview/types").ToolPreview;
        }>;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-batch-approval", handler);
    return () =>
      ipcRenderer.removeListener("ai:stream-tool-batch-approval", handler);
  },
  approveToolCallBatch: (
    batchId: string,
    approved: boolean,
    remember = false,
  ) =>
    ipcRenderer.invoke("ai:approveToolCallBatch", {
      batchId,
      approved,
      remember,
    }),
  onStreamToolBatchAutoApproved: (
    callback: (data: { id: string; batchId: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; batchId: string },
    ) => callback(data);
    ipcRenderer.on("ai:stream-tool-batch-auto-approved", handler);
    return () =>
      ipcRenderer.removeListener("ai:stream-tool-batch-auto-approved", handler);
  },
  onStreamRetry: (
    callback: (data: {
      id: string;
      attempt: number;
      type: string;
      maxRetries: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; attempt: number; type: string; maxRetries: number },
    ) => callback(data);
    ipcRenderer.on("ai:stream-retry", handler);
    return () => ipcRenderer.removeListener("ai:stream-retry", handler);
  },
  onStreamDone: (
    callback: (data: {
      id: string;
      sessionId?: string;
      assistantMessageId?: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        sessionId?: string;
        assistantMessageId?: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-done", handler);
    return () => ipcRenderer.removeListener("ai:stream-done", handler);
  },
  onStreamError: (
    callback: (data: {
      id: string;
      sessionId?: string;
      assistantMessageId?: string;
      error: string;
      type?: string;
      recoveryActions?: string[];
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        sessionId?: string;
        assistantMessageId?: string;
        error: string;
        type?: string;
        recoveryActions?: string[];
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-error", handler);
    return () => ipcRenderer.removeListener("ai:stream-error", handler);
  },

  onStreamClarification: (
    callback: (data: {
      id: string;
      clarificationId: string;
      question: string;
      options?: string[];
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        clarificationId: string;
        question: string;
        options?: string[];
      },
    ) => callback(data);
    ipcRenderer.on("ai:stream-clarification", handler);
    return () => ipcRenderer.removeListener("ai:stream-clarification", handler);
  },

  /**
   * agent 内 `createPlan` 工具的流。携带一个执行中状态的 `PlanView`,
   * 渲染进程会将其作为内联的 `PlanMessagePart` 推入/更新到聊天中。
   * 区别于 `onPlanReady`,后者供给旧版审批流程。
   */
  onStreamPlan: (callback: (data: { id: string; plan: unknown }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; plan: unknown },
    ) => callback(data);
    ipcRenderer.on("ai:stream-plan", handler);
    return () => ipcRenderer.removeListener("ai:stream-plan", handler);
  },

  // Watchdog 事件(卡顿检测)
  onWatchdog: (
    callback: (data: {
      taskId: string;
      type: "stall-warning" | "stall-recovered" | "stall-timeout";
      planId?: string;
      stepId?: number;
      idleMs?: number;
      threshold?: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        taskId: string;
        type: "stall-warning" | "stall-recovered" | "stall-timeout";
        planId?: string;
        stepId?: number;
        idleMs?: number;
        threshold?: number;
      },
    ) => callback(data);
    ipcRenderer.on("ai:watchdog", handler);
    return () => ipcRenderer.removeListener("ai:watchdog", handler);
  },

  // 审批超时事件
  onApprovalTimeout: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      timeoutMs: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        toolCallId: string;
        toolName: string;
        timeoutMs: number;
      },
    ) => callback(data);
    ipcRenderer.on("ai:approval-timeout", handler);
    return () => ipcRenderer.removeListener("ai:approval-timeout", handler);
  },

  // 工具自动批准事件(计划执行时跳过单个审批)
  onToolAutoApproved: (
    callback: (data: {
      id: string;
      toolCallId: string;
      toolName: string;
      path: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string;
        toolCallId: string;
        toolName: string;
        path: string;
      },
    ) => callback(data);
    ipcRenderer.on("ai:tool-auto-approved", handler);
    return () => ipcRenderer.removeListener("ai:tool-auto-approved", handler);
  },

  // 设置
  getSetting: (key: string) => ipcRenderer.invoke("settings:get", key),
  setSetting: (key: string, value: string) =>
    ipcRenderer.invoke("settings:set", key, value),
  getAllSettings: () => ipcRenderer.invoke("settings:getAll"),

  // 自动化
  automations: {
    list: (filter?: {
      enabled?: boolean;
      type?: AutomationType;
      threadId?: string;
    }): Promise<AutomationRecord[]> =>
      ipcRenderer.invoke("automations:list", filter),
    listRuns: (filter?: {
      automationId?: string;
      status?: AutomationRunStatus;
      triageStatus?: AutomationRunTriageStatus;
      limit?: number;
      offset?: number;
    }): Promise<AutomationRunRecord[]> =>
      ipcRenderer.invoke("automations:listRuns", filter),
    create: (payload: AutomationCreatePayload): Promise<AutomationRecord> =>
      ipcRenderer.invoke("automations:create", payload),
    update: (
      id: string,
      updates: Partial<
        Omit<AutomationRecord, "id" | "createdAt" | "updatedAt" | "nextRunAt">
      >,
    ): Promise<AutomationRecord> =>
      ipcRenderer.invoke("automations:update", { id, updates }),
    trigger: (id: string): Promise<AutomationRunRecord> =>
      ipcRenderer.invoke("automations:trigger", { id }),
    prepareChatRun: (payload: {
      assistantMessageId: string;
      id: string;
      sessionId: string;
    }): Promise<AutomationRunRecord> =>
      ipcRenderer.invoke("automations:prepareChatRun", payload),
    rerun: (id: string): Promise<AutomationRunRecord> =>
      ipcRenderer.invoke("automations:rerun", { id }),
    markRunHandled: (id: string): Promise<AutomationRunRecord> =>
      ipcRenderer.invoke("automations:markRunHandled", { id }),
    cancelRun: (id: string): Promise<AutomationRunRecord> =>
      ipcRenderer.invoke("automations:cancelRun", { id }),
    cleanupRuns: (payload?: {
      olderThanDays?: number;
      triageStatus?: AutomationRunTriageStatus;
    }): Promise<{ deleted: number }> =>
      ipcRenderer.invoke("automations:cleanupRuns", payload),
    previewSchedule: (payload: {
      scheduleKind: AutomationScheduleKind;
      scheduleValue: string;
    }): Promise<{ nextRunAt: string; timeZone: string }> =>
      ipcRenderer.invoke("automations:previewSchedule", payload),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("automations:delete", { id }),
  },

  // 危险工具白名单(持久化,可在设置面板管理)
  toolWhitelist: {
    getState: (): Promise<{ tools: string[]; enabled: string[] }> =>
      ipcRenderer.invoke("tool-whitelist:getState"),
    set: (toolName: string, enabled: boolean) =>
      ipcRenderer.invoke("tool-whitelist:set", { toolName, enabled }),
  },

  // LLM 配置
  llmConfig: {
    list: () => ipcRenderer.invoke("llm-config:list"),
    get: (id: string) => ipcRenderer.invoke("llm-config:get", { id }),
    create: (data: {
      name: string;
      provider:
        | "openai"
        | "anthropic"
        | "deepseek"
        | "ollama"
        | "custom"
        | "minimax"
        | "xiaomi";
      apiKey?: string;
      baseUrl?: string;
      model: string;
      modality?: "chat" | "image" | "video";
      isDefault?: boolean;
    }) => ipcRenderer.invoke("llm-config:create", data),
    update: (
      id: string,
      data: {
        name?: string;
        provider?:
          | "openai"
          | "anthropic"
          | "deepseek"
          | "ollama"
          | "custom"
          | "minimax"
          | "xiaomi";
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        modality?: "chat" | "image" | "video";
        isDefault?: boolean;
      },
    ) => ipcRenderer.invoke("llm-config:update", { id, ...data }),
    delete: (id: string) => ipcRenderer.invoke("llm-config:delete", { id }),
  },

  // 媒体(图像 / 视频生成)
  media: {
    generateImage: (data: {
      llmConfigId: string;
      sessionId: string;
      prompt: string;
      aspectRatio?: string;
    }) => ipcRenderer.invoke("media:generate-image", data),
    createVideoJob: (data: {
      llmConfigId: string;
      sessionId: string;
      prompt: string;
    }) => ipcRenderer.invoke("media:create-video-job", data),
    cancelJob: (jobId: string) =>
      ipcRenderer.invoke("media:cancel-job", { jobId }),
    listActiveJobs: () => ipcRenderer.invoke("media:list-active-jobs"),
    onJobUpdate: (
      callback: (event: {
        jobId: string;
        status: "queued" | "running" | "succeeded" | "failed" | "canceled";
        progressPct?: number | null;
        resultPath?: string | null;
        errorMessage?: string | null;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          jobId: string;
          status: "queued" | "running" | "succeeded" | "failed" | "canceled";
          progressPct?: number | null;
          resultPath?: string | null;
          errorMessage?: string | null;
        },
      ) => callback(data);
      ipcRenderer.on("ai:media-job-update", handler);
      return () => ipcRenderer.removeListener("ai:media-job-update", handler);
    },
  },

  // 用量跟踪
  usage: {
    getTaskUsage: (taskId: string) =>
      ipcRenderer.invoke("usage:getTaskUsage", { taskId }),
    getAggregateUsage: (params?: {
      from?: string;
      to?: string;
      provider?: string;
    }) => ipcRenderer.invoke("usage:getAggregateUsage", params ?? {}),
    getRecentUsage: (limit?: number) =>
      ipcRenderer.invoke("usage:getRecentUsage", { limit }),
  },

  // 记忆调试
  memoryDebug: {
    getEvents: (limit?: number) =>
      ipcRenderer.invoke("memory-debug:getEvents", { limit }),
    clear: () => ipcRenderer.invoke("memory-debug:clear"),
    seed: () => ipcRenderer.invoke("memory-debug:seed"),
    onEvent: (
      callback: (data: {
        taskId: string;
        type:
          | "compression-write"
          | "compression-skip"
          | "compression-error"
          | "result-summarize"
          | "truncation-drop"
          | "cache-write"
          | "cache-hit";
        promptSnippet?: string;
        detail: Record<string, unknown>;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          taskId: string;
          type:
            | "compression-write"
            | "compression-skip"
            | "compression-error"
            | "result-summarize"
            | "truncation-drop"
            | "cache-write"
            | "cache-hit";
          promptSnippet?: string;
          detail: Record<string, unknown>;
        },
      ) => callback(data);
      ipcRenderer.on("ai:memory-event", handler);
      return () => ipcRenderer.removeListener("ai:memory-event", handler);
    },
  },

  // 工作目录记忆(查看 / 清空)。机器记忆存于 ~/.filework/workspace-memory。
  workspaceMemory: {
    get: (
      workspacePath: string,
    ): Promise<{
      agentMemoryPath: string;
      userMemoryPath: string;
      workspaceEntries: WorkspaceMemoryEntry[];
      userEntries: WorkspaceMemoryEntry[];
      humanFile: string | null;
      humanContent: string | null;
      combined: string | null;
    } | null> => ipcRenderer.invoke("workspace-memory:get", { workspacePath }),
    clear: (workspacePath: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace-memory:clear", { workspacePath }),
    clearUser: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace-memory:clear-user"),
    forget: (
      workspacePath: string,
      scope: "user" | "workspace",
      key: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace-memory:forget", {
        workspacePath,
        scope,
        key,
      }),
    update: (
      workspacePath: string,
      scope: "user" | "workspace",
      key: string,
      category: "preference" | "project" | "convention" | "reference",
      text: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace-memory:update", {
        workspacePath,
        scope,
        key,
        category,
        text,
      }),
  },

  // 任务追踪(持久化执行追踪)
  taskTrace: {
    getEvents: (taskId: string, limit?: number) =>
      ipcRenderer.invoke("task-trace:getEvents", { taskId, limit }),
    getSummary: (taskId: string) =>
      ipcRenderer.invoke("task-trace:getSummary", { taskId }),
    onEvent: (
      callback: (data: {
        taskId: string;
        type: string;
        timestamp: string;
        toolCallId?: string;
        toolName?: string;
        detail: Record<string, unknown>;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          taskId: string;
          type: string;
          timestamp: string;
          toolCallId?: string;
          toolName?: string;
          detail: Record<string, unknown>;
        },
      ) => callback(data);
      ipcRenderer.on("ai:task-trace-event", handler);
      return () => ipcRenderer.removeListener("ai:task-trace-event", handler);
    },
  },

  // 本地(非克隆)git 操作
  local: {
    probeGit: (payload: { path: string }) =>
      ipcRenderer.invoke("local-git:probe", payload),
    listBranches: (payload: { path: string }) =>
      ipcRenderer.invoke("local-git:listBranches", payload),
    checkoutBranch: (payload: { path: string; branch: string }) =>
      ipcRenderer.invoke("local-git:checkoutBranch", payload),
  },

  // 聚合分支差异(codex 风格的「分支 vs 基线」抽屉)。
  getBranchDiff: (payload: {
    path: string;
    baseBranch?: string;
  }): Promise<import("../main/core/git-diff/types").BranchDiff> =>
    ipcRenderer.invoke("git:getBranchDiff", payload),

  // 工作区级事件
  onWorkspaceBranchChanged: (
    callback: (data: { cloneDir: string; branch: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { cloneDir: string; branch: string },
    ) => callback(data);
    ipcRenderer.on("workspace:branch-changed", handler);
    return () =>
      ipcRenderer.removeListener("workspace:branch-changed", handler);
  },

  // 工作区历史
  getRecentWorkspaces: () => ipcRenderer.invoke("workspace:getRecent"),
  addRecentWorkspace: (
    pathOrId: string,
    name: string,
    opts?: {
      kind?: "local" | "github" | "gitlab";
      metadata?: string | null;
    },
  ) => ipcRenderer.invoke("workspace:addRecent", pathOrId, name, opts),
  removeRecentWorkspace: (path: string) =>
    ipcRenderer.invoke("workspace:removeRecent", path),

  // 凭证
  credentials: {
    list: () => ipcRenderer.invoke("credentials:list"),
    create: (payload: {
      kind: CredentialKind;
      label: string;
      token: string;
      scopes?: string[];
    }) => ipcRenderer.invoke("credentials:create", payload),
    update: (
      id: string,
      payload: {
        kind: CredentialKind;
        label: string;
        token?: string;
        scopes?: string[];
      },
    ) => ipcRenderer.invoke("credentials:update", { id, ...payload }),
    delete: (id: string) => ipcRenderer.invoke("credentials:delete", { id }),
    test: (payload: {
      id?: string;
      token?: string;
      kind?: CredentialKind;
      host?: string;
    }) => ipcRenderer.invoke("credentials:test", payload),
  },

  // GitHub
  github: {
    listRepos: (credentialId: string) =>
      ipcRenderer.invoke("github:listRepos", { credentialId }),
    listBranches: (payload: {
      credentialId: string;
      owner: string;
      repo: string;
    }) => ipcRenderer.invoke("github:listBranches", payload),
    cloneRepo: (payload: {
      credentialId: string;
      owner: string;
      repo: string;
      ref: string;
    }) => ipcRenderer.invoke("github:cloneRepo", payload),
    fetchRepo: (payload: {
      credentialId: string;
      owner: string;
      repo: string;
      ref: string;
    }) => ipcRenderer.invoke("github:fetchRepo", payload),
    checkoutBranch: (payload: {
      credentialId: string;
      owner: string;
      repo: string;
      ref: string;
      branch: string;
    }) => ipcRenderer.invoke("github:checkoutBranch", payload),
  },

  // GitLab
  gitlab: {
    listProjects: (payload: { credentialId: string; host: string }) =>
      ipcRenderer.invoke("gitlab:listProjects", payload),
    listBranches: (payload: {
      credentialId: string;
      host: string;
      namespace: string;
      project: string;
    }) => ipcRenderer.invoke("gitlab:listBranches", payload),
    cloneRepo: (payload: {
      credentialId: string;
      host: string;
      namespace: string;
      project: string;
      ref: string;
    }) => ipcRenderer.invoke("gitlab:cloneRepo", payload),
    fetchRepo: (payload: {
      credentialId: string;
      host: string;
      namespace: string;
      project: string;
      ref: string;
    }) => ipcRenderer.invoke("gitlab:fetchRepo", payload),
    checkoutBranch: (payload: {
      credentialId: string;
      host: string;
      namespace: string;
      project: string;
      ref: string;
      branch: string;
    }) => ipcRenderer.invoke("gitlab:checkoutBranch", payload),
  },

  // MCP(Model Context Protocol)服务器
  mcp: {
    listServers: () => ipcRenderer.invoke("mcp:listServers"),
    addServer: (payload: {
      name: string;
      transport: "stdio" | "http";
      command?: string | null;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string | null;
      url?: string | null;
      headers?: Record<string, string>;
      authType?: "auto" | "none" | "oauth";
      oauthScopes?: string[];
      oauthClientId?: string | null;
      oauthClientSecret?: string | null;
      enabled?: boolean;
      trusted?: boolean;
    }) => ipcRenderer.invoke("mcp:addServer", payload),
    updateServer: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke("mcp:updateServer", { id, updates }),
    deleteServer: (id: string) =>
      ipcRenderer.invoke("mcp:deleteServer", { id }),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("mcp:setEnabled", { id, enabled }),
    setTrusted: (id: string, trusted: boolean) =>
      ipcRenderer.invoke("mcp:setTrusted", { id, trusted }),
    reconnect: (id: string) => ipcRenderer.invoke("mcp:reconnect", { id }),
    authorize: (id: string) => ipcRenderer.invoke("mcp:authorize", { id }),
    clearAuthorization: (id: string) =>
      ipcRenderer.invoke("mcp:clearAuthorization", { id }),
    listTools: (id: string) => ipcRenderer.invoke("mcp:listTools", { id }),
    importJson: (json: string) =>
      ipcRenderer.invoke("mcp:importJson", { json }),
    testConnection: (payload: {
      name: string;
      transport: "stdio" | "http";
      command?: string | null;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string | null;
      url?: string | null;
      headers?: Record<string, string>;
      authType?: "auto" | "none" | "oauth";
      oauthScopes?: string[];
      oauthClientId?: string | null;
      oauthClientSecret?: string | null;
    }) => ipcRenderer.invoke("mcp:testConnection", payload),
    onStatusChanged: (
      handler: (payload: { id: string; status: unknown }) => void,
    ) => {
      const wrapped = (_e: unknown, payload: { id: string; status: unknown }) =>
        handler(payload);
      ipcRenderer.on("mcp:server-status-changed", wrapped);
      return () =>
        ipcRenderer.removeListener("mcp:server-status-changed", wrapped);
    },
    onListChanged: (handler: () => void) => {
      const wrapped = () => handler();
      ipcRenderer.on("mcp:server-list-changed", wrapped);
      return () =>
        ipcRenderer.removeListener("mcp:server-list-changed", wrapped);
    },
  },

  // 聊天会话
  createChatSession: (workspacePath: string, title?: string) =>
    ipcRenderer.invoke("chat:createSession", workspacePath, title),
  getChatSessions: (workspacePath: string) =>
    ipcRenderer.invoke("chat:getSessions", workspacePath),
  updateChatSession: (
    sessionId: string,
    updates: { title?: string; updatedAt?: string },
  ) => ipcRenderer.invoke("chat:updateSession", sessionId, updates),
  deleteChatSession: (sessionId: string) =>
    ipcRenderer.invoke("chat:deleteSession", sessionId),
  forkChatSession: (sessionId: string, fromMessageId: string) =>
    ipcRenderer.invoke("chat:forkSession", sessionId, fromMessageId),

  // 聊天历史(会话作用域)
  getChatHistory: (sessionId: string) =>
    ipcRenderer.invoke("chat:getHistory", sessionId),
  saveChatHistory: (
    sessionId: string,
    workspacePath: string,
    messages: unknown[],
  ) =>
    ipcRenderer.invoke("chat:saveHistory", sessionId, workspacePath, messages),
};

contextBridge.exposeInMainWorld("filework", api);

export type FileWorkAPI = typeof api;
