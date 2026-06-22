import type {
  MessagePart,
  ToolApproval,
  ToolState,
} from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// Message part types — single source of truth in core/session/message-parts.
// Re-exported here so existing renderer imports (`from "./types"`) keep
// working without changes.
// ---------------------------------------------------------------------------

export type {
  ArticleMetaPart,
  AttachmentKind,
  AttachmentPart,
  BatchApprovalEntry,
  BatchApprovalPart,
  ClarificationPart,
  ErrorPart,
  ImageGalleryPart,
  ImagePart,
  MessagePart,
  PlanMessagePart,
  ReasoningPart,
  RecoveryAction,
  SubagentChildView,
  SubagentMessagePart,
  TextPart,
  ToolApproval,
  ToolPart,
  TurnSummaryCommand,
  TurnSummaryFile,
  TurnSummaryPart,
  UsagePart,
  VideoGalleryPart,
  VideoJobPart,
} from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// Chat data types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  parts?: MessagePart[];
  /** @deprecated kept for backward compat with saved history */
  toolInvocations?: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    result?: unknown;
    state: ToolState;
    approval?: ToolApproval;
  }[];
}

export interface ChatSession {
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  automationRun?: {
    id: string;
    automationId: string;
    title: string;
  };
}

export interface ActiveSkillInfo {
  skillId: string;
  skillName: string;
  source: string;
}
