/**
 * Public surface of `@/main/core` — the domain-neutral Agent runtime.
 *
 * This module is intentionally Electron-free, SQLite-free, and React-free.
 * It can be imported by `src/main/ipc/*` (PR 2) and, in the M4 SDK split,
 * by an external Node consumer with no Electron context.
 */

// AgentLoop
export {
  AgentLoop,
  type AgentLoopConfig,
  type AgentLoopHooks,
  type TransformContextHook,
  type TransformContextResult,
} from "./agent/agent-loop";
// Agent events
export type {
  AgentEndStatus,
  AgentEvent,
  AgentEventListener,
  AgentEventType,
  ClassifiedAgentError,
  TokenUsage,
  TurnEndReason,
} from "./agent/events";
// Retry
export {
  type ClassifiedRetryError,
  type ErrorClassifier,
  type WithRetryOptions,
  withRetry,
} from "./agent/retry";
// Tool registry
export type {
  BeforeToolCallDecision,
  BeforeToolCallHook,
  ToolContext,
  ToolDefinition,
  ToolDeniedResult,
} from "./agent/tool-registry";
export { ToolRegistry } from "./agent/tool-registry";
// Built-in tools
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
// Workspace
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
