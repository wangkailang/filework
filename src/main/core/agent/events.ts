/**
 * Agent 事件分类体系。
 *
 * AgentLoop 发出一串带类型的事件,供消费者(M1 中的 Electron IPC
 * 转换器、未来的 SDK 消费者、内部测试)订阅。
 *
 * 事件形态对应 PI 的 pi-agent-core 事件流:
 * agent_start → turn_start → message_start/update/end → tool_execution_*
 * → turn_end → agent_end。外加 retry / context_compressed 这类横切的
 * 生命周期信号。
 *
 * 注意:`message_update` 携带的是原始增量(RAW delta)。节流 / 批处理
 * 由消费者负责(Electron IPC 消费者把它们喂给 `DeltaBatcher`;
 * SDK 消费者可以直接将它们管道输出到 stdout)。
 */

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** 模型在隐藏推理上消耗的 token(o 系列、DeepSeek-R1、Claude 扩展思考)。 */
  reasoningTokens?: number | null;
}

export interface ClassifiedAgentError {
  message: string;
  type: string;
  recoveryActions?: string[];
}

export type TurnEndReason = "tool_calls" | "finish" | "stop" | "error";

export type AgentEndStatus = "completed" | "failed" | "cancelled";

/**
 * agent 因某个硬上限提前收束的原因。三上限统一收口到 AgentLoop:
 * 步数到顶(max_steps)、累计 token 超预算(token_budget)、墙钟超时(wall_clock)。
 * 命中任一时,agent_end 仍以 status="completed" 返回(产出有效,只是被截断),
 * 借由 stopReason 区分"自然结束"与"被硬限截断"。
 */
export type AgentStopReason = "max_steps" | "token_budget" | "wall_clock";

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
      /** 原始文本增量——不要在 AgentLoop 内部批处理;消费者按需自行节流。 */
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
      type: "reasoning_update";
      agentId: string;
      messageId: string;
      /**
       * 原始推理文本增量。AgentLoop 对 AI SDK fullStream 中的每个
       * `reasoning-delta` 块发出一个事件,因此消费者若想要平滑的 UI 更新,
       * 应自行批处理 / 节流。
       */
      deltaText: string;
    }
  | {
      type: "reasoning_end";
      agentId: string;
      messageId: string;
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
      /** 所有轮次的聚合用量。在 streamText 解析出它时填充。 */
      totalUsage?: TokenUsage;
      /** 提供方特有的元数据(例如缓存头)。对 core 而言是不透明的。 */
      providerMetadata?: Record<string, unknown>;
      /** 所有 assistant message_end 的 finalText 值的拼接。 */
      finalText?: string;
      /**
       * 命中硬上限而提前收束时填充(status 仍为 "completed")。
       * undefined 表示自然结束(模型主动停或全部回合跑完)。
       */
      stopReason?: AgentStopReason;
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
    }
  | {
      type: "reflection_verdict";
      agentId: string;
      /** 本次反思周期的尝试计数器(从 0 开始)。 */
      attempt: number;
      verdict:
        | { kind: "continue" }
        | { kind: "retry"; feedback: string }
        | { kind: "abort"; reason: string };
    };

export type AgentEventType = AgentEvent["type"];

/** 订阅者回调。按注册顺序被 await。 */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
