import type { ApprovalState } from "../ai-elements/confirmation";
import type { ToolState } from "../ai-elements/tool";
import type { PlanView } from "../ai-elements/plan-viewer";

// ---------------------------------------------------------------------------
// Message part types
// ---------------------------------------------------------------------------

export interface ToolApproval {
  toolCallId: string;
  toolName: string;
  description: string;
  state: ApprovalState;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  state: ToolState;
  approval?: ToolApproval;
}

export interface PlanMessagePart {
  type: "plan";
  plan: PlanView;
}

export type MessagePart = TextPart | ToolPart | PlanMessagePart;

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
}

export interface ActiveSkillInfo {
  skillId: string;
  skillName: string;
  source: string;
}
