/**
 * `@/main/core` 的公共出口 —— 与领域无关的 Agent 运行时。
 *
 * 本模块刻意不依赖 Electron、SQLite 和 React。
 * 它可被 `src/main/ipc/*`(PR 2)导入,并且在 M4 SDK 拆分中,
 * 也可被一个无 Electron 上下文的外部 Node 消费方导入。
 */

// AgentLoop
export {
  AgentLoop,
  type AgentLoopConfig,
  type AgentLoopHooks,
  type TransformContextHook,
  type TransformContextResult,
} from "./agent/agent-loop";
// Agent 事件
export type {
  AgentEndStatus,
  AgentEvent,
  AgentEventListener,
  AgentEventType,
  ClassifiedAgentError,
  TokenUsage,
  TurnEndReason,
} from "./agent/events";
// 重试
export {
  type ClassifiedRetryError,
  type ErrorClassifier,
  type WithRetryOptions,
  withRetry,
} from "./agent/retry";
// 工具注册表
export type {
  BeforeToolCallDecision,
  BeforeToolCallHook,
  ToolContext,
  ToolDefinition,
  ToolDeniedResult,
} from "./agent/tool-registry";
export { ToolRegistry } from "./agent/tool-registry";
// 内置工具
export {
  buildFileTools,
  createDirectoryTool,
  deleteFileTool,
  directoryStatsTool,
  type FileToolsDeps,
  type IncrementalScannerLike,
  type IncrementalScanResult,
  moveFileTool,
  readFileTool,
  runCommandTool,
  runProcessTool,
  type WorkspaceEntryLike,
  writeFileTool,
} from "./agent/tools";
export {
  createRunSkillTool,
  type SkillResolver,
  type SkillResolverSkill,
} from "./agent/tools/run-skill";
export {
  LocalWorkspace,
  type LocalWorkspaceOptions,
} from "./workspace/local-workspace";
// 工作区
export type {
  ExecOptions,
  ExecResult,
  FileStat,
  ListOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Workspace,
  WorkspaceEntry,
  WorkspaceExec,
  WorkspaceFS,
  WorkspaceKind,
  WorkspaceSCM,
} from "./workspace/types";
export { WorkspaceEscapeError } from "./workspace/types";
