/**
 * Storage shape for chat message parts.
 *
 * Hosted in `core/` so the JSONL session store, the future headless SDK,
 * and the renderer all read the same source of truth. Renderer modules
 * (chat/types.ts, ai-elements/confirmation.tsx, ai-elements/tool.tsx,
 * ai-elements/plan-viewer.tsx) re-export from here — no parallel
 * definitions to keep in sync.
 *
 * These are intentionally pure type definitions: no React, no DOM, no
 * Electron. The renderer's UI components live separately and consume
 * these shapes.
 */

// ─── Confirmation / Approval ────────────────────────────────────────

export type ApprovalState =
  | "approval-requested"
  | "approval-accepted"
  | "approval-rejected";

// ─── Tool execution state ───────────────────────────────────────────

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export interface ToolApproval {
  toolCallId: string;
  toolName: string;
  description: string;
  state: ApprovalState;
  /**
   * Optional contextual warning the renderer shows above the approval card.
   * Populated by `approval-hook.ts` for openPullRequest when the latest CI
   * run on the head branch is failing/cancelled (M8). Undefined for all
   * other tools and pre-M8 sessions.
   */
  extraContext?: string;
}

// ─── Plan viewer (data shape — UI lives in plan-viewer.tsx) ─────────

export interface PlanSubStepView {
  label: string;
  status: "pending" | "done";
}

export interface PlanStepArtifactView {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  success: boolean;
}

export interface PlanStepView {
  id: number;
  action: string;
  description: string;
  skillId?: string;
  verification?: string;
  subSteps?: PlanSubStepView[];
  artifacts?: PlanStepArtifactView[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  error?: string;
}

export interface PlanView {
  id: string;
  goal: string;
  steps: PlanStepView[];
  status:
    | "draft"
    | "approved"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
}

// ─── Recovery actions surfaced on errors ────────────────────────────

export type RecoveryAction = "retry" | "settings" | "new_chat";

// ─── MessagePart variants ───────────────────────────────────────────

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

export interface ErrorPart {
  type: "error";
  message: string;
  errorType?: string;
  recoveryActions?: RecoveryAction[];
}

export interface UsagePart {
  type: "usage";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelId: string | null;
  provider: string | null;
}

export interface ClarificationPart {
  type: "clarification";
  question: string;
  options?: string[];
}

export type MessagePart =
  | TextPart
  | ToolPart
  | PlanMessagePart
  | ErrorPart
  | UsagePart
  | ClarificationPart;
