/**
 * Agent event taxonomy.
 *
 * AgentLoop emits a stream of typed events that consumers (Electron IPC
 * translator in M1, future SDK consumers, internal tests) subscribe to.
 *
 * The event shape mirrors PI's pi-agent-core event flow:
 * agent_start → turn_start → message_start/update/end → tool_execution_*
 * → turn_end → agent_end. Plus retry / context_compressed for cross-cutting
 * lifecycle signals.
 *
 * Note: `message_update` carries RAW deltas. Throttling / batching is the
 * consumer's responsibility (Electron IPC consumer feeds these into
 * `DeltaBatcher`; an SDK consumer may pipe them straight to stdout).
 */

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export interface ClassifiedAgentError {
  message: string;
  type: string;
  recoveryActions?: string[];
}

export type TurnEndReason = "tool_calls" | "finish" | "stop" | "error";

export type AgentEndStatus = "completed" | "failed" | "cancelled";

export type AgentEvent =
  | {
      type: "agent_start";
      agentId: string;
      prompt: string;
      timestamp: string;
    }
  | {
      type: "turn_start";
      agentId: string;
      turnIndex: number;
    }
  | {
      type: "message_start";
      agentId: string;
      messageId: string;
      role: "assistant";
    }
  | {
      type: "message_update";
      agentId: string;
      messageId: string;
      /** Raw text delta — do not batch inside AgentLoop; consumers throttle if they need to. */
      deltaText: string;
    }
  | {
      type: "message_end";
      agentId: string;
      messageId: string;
      finalText: string;
      usage?: TokenUsage;
    }
  | {
      type: "tool_execution_start";
      agentId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      agentId: string;
      toolCallId: string;
      partial: unknown;
    }
  | {
      type: "tool_execution_end";
      agentId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      success: boolean;
      durationMs: number;
    }
  | {
      type: "tool_approval_request";
      agentId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      description: string;
    }
  | {
      type: "turn_end";
      agentId: string;
      turnIndex: number;
      reason: TurnEndReason;
    }
  | {
      type: "agent_end";
      agentId: string;
      status: AgentEndStatus;
      error?: ClassifiedAgentError;
    }
  | {
      type: "retry";
      agentId: string;
      turnIndex: number;
      attempt: number;
      errorType: string;
    }
  | {
      type: "context_compressed";
      agentId: string;
      originalTokens: number;
      compressedTokens: number;
    };

export type AgentEventType = AgentEvent["type"];

/** Subscriber callback. Awaited in registration order. */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
