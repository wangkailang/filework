/**
 * Chat-scoped workflow state for the brainstorming HARD-GATE.
 *
 * The brainstorming process skill (`.agents/skills/brainstorming/`)
 * requires the agent to produce a design and get explicit user
 * approval BEFORE any destructive tool runs. This module owns the
 * tiny piece of state that lets the `beforeToolCall` design gate
 * decide whether approval has happened in the current chat session.
 *
 * Keyed by chat `sessionId` so the approval survives multiple
 * `handleTaskExecution` invocations within one chat. When `sessionId`
 * is absent (skills, headless invocations, e2e harness), callers fall
 * back to `taskId` — approval is then effectively per-turn, which is
 * the safest default for one-shot contexts.
 */

export interface ChatWorkflowState {
  /** True once the user has approved a pending design in this chat. */
  designApproved: boolean;
  /** The most recent design markdown sent to the user, if any. */
  pendingDesignDoc?: string;
  /** ISO-8601 timestamp of the most recent approve/reject decision. */
  decidedAt?: string;
  /** Rejection reason from the most recent reject decision. */
  lastRejectReason?: string;
}

const states = new Map<string, ChatWorkflowState>();

/**
 * Resolve a stable key from the (sessionId, taskId) pair.
 *
 * Prefers `sessionId` so the gate survives across the many task IDs a
 * single chat issues during a multi-turn conversation.
 */
export const resolveWorkflowKey = (
  sessionId: string | undefined,
  taskId: string,
): string => sessionId ?? taskId;

/** Read the current workflow state for a chat (or a fresh default). */
export const getWorkflowState = (key: string): ChatWorkflowState => {
  return states.get(key) ?? { designApproved: false };
};

/** Has the user approved a design in this chat? */
export const isDesignApproved = (key: string): boolean => {
  return states.get(key)?.designApproved === true;
};

/**
 * Record a design that the agent has just sent to the user for
 * approval. Does NOT mark it approved — approval requires a separate
 * `recordDesignDecision({approved: true, …})` from the renderer.
 */
export const recordPendingDesign = (key: string, design: string): void => {
  const prev = states.get(key) ?? { designApproved: false };
  states.set(key, {
    ...prev,
    designApproved: false,
    pendingDesignDoc: design,
    decidedAt: undefined,
    lastRejectReason: undefined,
  });
};

/**
 * Record the user's approve / reject decision for the pending design.
 *
 * `approved=true` flips the gate open for the remainder of the chat —
 * subsequent destructive tool calls will pass through the design gate.
 * `approved=false` keeps the gate shut and stores the reject reason so
 * the next agent turn can surface it.
 */
export const recordDesignDecision = (
  key: string,
  decision: { approved: boolean; reason?: string },
): void => {
  const prev = states.get(key) ?? { designApproved: false };
  states.set(key, {
    ...prev,
    designApproved: decision.approved,
    decidedAt: new Date().toISOString(),
    lastRejectReason: decision.approved ? undefined : decision.reason,
  });
};

/** Drop state for a chat (call on chat delete / reset). */
export const clearWorkflowState = (key: string): void => {
  states.delete(key);
};

/** Test-only: wipe all state. */
export const __resetAllWorkflowStateForTests = (): void => {
  states.clear();
};
