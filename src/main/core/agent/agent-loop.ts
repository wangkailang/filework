/**
 * AgentLoop —— 领域无关的编排器,通过 Vercel AI SDK 的 `streamText`
 * 运行一组模型回合,把 `fullStream` 转换为带类型的 `AgentEvent`,
 * 并以异步可迭代对象的形式产出。
 *
 * 取代 `src/main/ipc/ai-handlers.ts:476-568` 处内联的 `streamAndConsume`
 * 循环。行为对齐:
 * - 单次 `streamText` 调用,外包可选的重试(回合级粒度)
 * - 用于压缩的 `transformContext` 钩子(原内联于 243-305 行)
 * - `beforeToolCall` 经由 ToolRegistry 路由(PR 1)—— 此处无需额外接线
 * - 通过 AbortSignal 取消
 *
 * 注意:AI-SDK 的 `streamText` 本身已最多循环 `stepCountIs(N)` 个内部
 * 步骤。每个 "step" 是一次模型决策(纯文本或文本+工具调用)
 * —— 我们把步骤边界映射为 PI 风格的回合事件。
 */

import { randomUUID } from "node:crypto";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel, ModelMessage, Tool } from "ai";
import { stepCountIs, streamText } from "ai";
import type { Workspace } from "../workspace/types";
import { compactToolResults } from "./compact-tool-results";
import type {
  AgentEndStatus,
  AgentEvent,
  AgentStopReason,
  ClassifiedAgentError,
  TokenUsage,
  TurnEndReason,
} from "./events";
import type {
  ReflectHook,
  ToolCallSummary,
  TurnSummary,
} from "./reflection-gate";
import type { ErrorClassifier } from "./retry";
import { withRetry } from "./retry";
import type { BeforeToolCallHook, ToolContext } from "./tool-registry";
import { ToolRegistry } from "./tool-registry";

// ---------------------------------------------------------------------------
// 钩子
// ---------------------------------------------------------------------------

export interface TransformContextResult {
  messages: ModelMessage[];
  /** 可选指标,以 `context_compressed` 事件形式暴露。 */
  originalTokens?: number;
  compressedTokens?: number;
}

export type TransformContextHook = (
  messages: ModelMessage[],
  signal?: AbortSignal,
) => Promise<TransformContextResult>;

export type ContextUsageHook = (payload: {
  messages: ModelMessage[];
  preparedMessages: ModelMessage[];
}) => void;

export interface AgentLoopHooks {
  beforeToolCall?: BeforeToolCallHook;
  transformContext?: TransformContextHook;
  contextUsage?: ContextUsageHook;
  /**
   * 可选的流后裁决钩子。存在时,AgentLoop 会在每次 `streamText` 调用后
   * 运行该钩子,并可附加反馈最多循环 `maxReflections` 次。
   * 未设置 → 行为与引入 reflection 之前的 AgentLoop 完全一致。
   */
  reflect?: ReflectHook;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  workspace: Workspace;
  model: LanguageModel;
  /**
   * 模型可用的工具。可传入 `ToolRegistry`(AgentLoop 会经由
   * `toAiSdkTools()` 转换并遵循 `beforeToolCall` 钩子),或传入预先
   * 构建好的 ai-sdk `Record<string, Tool>`(当 IPC 层想保留其既有的
   * 带审批包装的工具时)。
   */
  tools: ToolRegistry | Record<string, Tool>;
  systemPrompt: string;
  /** 既有的对话历史。不含新的用户 prompt。 */
  history?: ModelMessage[];
  hooks?: AgentLoopHooks;
  /** 每次 `streamText` 调用的 AI-SDK 内部步数硬上限。默认 20。 */
  maxStepsPerTurn?: number;
  /**
   * 传给 `streamText` 的采样 temperature。默认不设置(使用 provider
   * 默认值,通常为 0.7-1.0)。评测框架应将其设为 `0` 以获得可复现的运行。
   */
  temperature?: number;
  /** 传给 `streamText` 的 nucleus sampling 参数。默认不设置。 */
  topP?: number;
  /** 单次 `streamText` 调用允许模型生成的最大 token 数。默认不设置。 */
  maxOutputTokens?: number;
  /** 合并进 streamText 调用的 provider 专属选项。 */
  providerOptions?: ProviderOptions;
  /** 调用方提供的 abort。中止会取消本次运行。 */
  signal?: AbortSignal;
  /** 用于事件载荷的稳定 id。缺省时自动生成。 */
  agentId?: string;
  /** 可选的错误分类器,用于启用重试。没有它则不重试。 */
  classifyError?: ErrorClassifier;
  /**
   * 设置了 `hooks.reflect` 时的最大 reflection 循环次数。每个循环额外
   * 发起一次 `streamText` 调用。默认 2(因此 streamText 最多调用 3 次:
   * 初始 + 2 次重试)。
   */
  maxReflections?: number;
  /**
   * 整个 run 的累计 token 硬上限(input+output,跨所有 step 与 reflection)。
   * 命中后立即中止本次运行,agent_end 以 status="completed" +
   * stopReason="token_budget" 返回(已产出内容有效)。不设 → 不限。
   */
  maxTotalTokens?: number;
  /**
   * 整个 run 的墙钟硬上限(毫秒,跨所有 step 与 reflection)。命中后立即
   * 中止,agent_end 以 status="completed" + stopReason="wall_clock" 返回。
   * 不设 → 不限。子 agent 路径的 fork-skill-runner 另有外层 setTimeout 兜底。
   */
  maxWallMs?: number;
}

function contentContainsPrompt(
  content: ModelMessage["content"],
  prompt: string,
) {
  if (typeof content === "string") return content === prompt;
  if (!Array.isArray(content)) return false;

  if (prompt === "") {
    return content.some((part) => {
      if (typeof part !== "object" || part === null || !("type" in part)) {
        return false;
      }
      const type = (part as { type?: unknown }).type;
      return type === "image" || type === "file";
    });
  }

  return content.some((part) => {
    if (typeof part !== "object" || part === null || !("type" in part)) {
      return false;
    }
    const typed = part as { text?: unknown; type?: unknown };
    return typed.type === "text" && typed.text === prompt;
  });
}

function shouldAppendPrompt(history: ModelMessage[], prompt: string): boolean {
  const last = history.at(-1);
  return last?.role !== "user" || !contentContainsPrompt(last.content, prompt);
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  constructor(private readonly cfg: AgentLoopConfig) {}

  async *run(prompt: string): AsyncGenerator<AgentEvent, void, void> {
    const agentId = this.cfg.agentId ?? randomUUID();
    const queue: AgentEvent[] = [];
    let waiter: (() => void) | null = null;
    let producerDone = false;

    const emit = (e: AgentEvent) => {
      queue.push(e);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };

    const work = this.runProducer(agentId, prompt, emit).finally(() => {
      producerDone = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    });

    // 在消费方排空队列期间避免未捕获的 rejection。
    work.catch(() => {});

    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev !== undefined) yield ev;
      }
      if (producerDone) break;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    // 在队列完全排空之后再抛出生产方错误,以便消费方在 throw 之前
    // 先看到最终的 agent_end 事件。
    await work;
  }

  private async runProducer(
    agentId: string,
    prompt: string,
    emit: (e: AgentEvent) => void,
  ): Promise<void> {
    emit({
      type: "agent_start",
      agentId,
      prompt,
      timestamp: new Date().toISOString(),
    });

    // ── 硬上限统一收口 ────────────────────────────────────────────────
    // internalController 让 AgentLoop 能因 token/wall 超限主动中止自身
    //(cfg.signal 是外部传入的,AgentLoop 不能 abort 它)。把它与 cfg.signal
    // 合并后传给 streamText / 工具 / reflect,任一触发都干净传播。
    const internalController = new AbortController();
    const effectiveSignal: AbortSignal = this.cfg.signal
      ? AbortSignal.any([this.cfg.signal, internalController.signal])
      : internalController.signal;
    let stopReason: AgentStopReason | undefined;
    // 跨所有 step 与 reflection 的累计 token(input+output)。独立于用于
    // 上报的 totalUsage,避免与"每次 streamText 覆盖式赋值"语义打架。
    let cumulativeTokens = 0;

    const wallTimer =
      this.cfg.maxWallMs && this.cfg.maxWallMs > 0
        ? setTimeout(() => {
            if (!internalController.signal.aborted) {
              stopReason = "wall_clock";
              internalController.abort();
            }
          }, this.cfg.maxWallMs)
        : undefined;

    let history = this.cfg.history ?? [];

    // ── transformContext 钩子 ────────────────────────────────────────
    if (this.cfg.hooks?.transformContext) {
      try {
        const r = await this.cfg.hooks.transformContext(
          history,
          this.cfg.signal,
        );
        history = r.messages;
        if (
          typeof r.originalTokens === "number" &&
          typeof r.compressedTokens === "number"
        ) {
          emit({
            type: "context_compressed",
            agentId,
            originalTokens: r.originalTokens,
            compressedTokens: r.compressedTokens,
          });
        }
      } catch (err) {
        // 非致命:记录日志并以原始历史继续。
        console.warn(
          "[AgentLoop] transformContext hook failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const messages: ModelMessage[] = shouldAppendPrompt(history, prompt)
      ? [...history, { role: "user", content: prompt }]
      : [...history];

    const aiTools =
      this.cfg.tools instanceof ToolRegistry
        ? this.cfg.tools.toAiSdkTools({
            ctxFactory: ({ toolCallId }): ToolContext => ({
              workspace: this.cfg.workspace,
              signal: effectiveSignal,
              toolCallId,
            }),
            beforeToolCall: this.cfg.hooks?.beforeToolCall,
          })
        : this.cfg.tools;

    let totalUsage: TokenUsage | undefined;
    let providerMetadata: Record<string, unknown> | undefined;
    let finalTextAccum = "";
    // 仅在配置了 reflect 钩子时收集 —— 在默认聊天路径上省去 Map
    // 分配与每次工具调用的写入。
    const reflectEnabled = this.cfg.hooks?.reflect !== undefined;

    const callStreamText = async (
      passNoTools: boolean,
    ): Promise<TurnSummary> => {
      // 回合级缓冲 —— 重试时重置。
      let turnIndex = -1;
      let messageId = "";
      let messageText = "";
      let messageOpen = false;
      let lastFinishReason: string | undefined;
      const toolResults = reflectEnabled
        ? new Map<string, ToolCallSummary>()
        : undefined;

      const result = streamText({
        model: this.cfg.model,
        tools: passNoTools ? {} : aiTools,
        stopWhen: stepCountIs(this.cfg.maxStepsPerTurn ?? 20),
        system: this.cfg.systemPrompt,
        messages,
        // 在每个内部步骤前收缩较早的工具结果,避免大体量的
        // webFetch/runCommand 结果在每一步都以全尺寸重发
        //(输入 token 的倍增因素)。最新结果保持完整。
        prepareStep: ({ messages: stepMessages }) => {
          const compacted = compactToolResults(stepMessages);
          try {
            this.cfg.hooks?.contextUsage?.({
              messages: stepMessages,
              preparedMessages: compacted ?? stepMessages,
            });
          } catch (err) {
            console.warn(
              "[AgentLoop] contextUsage hook failed:",
              err instanceof Error ? err.message : err,
            );
          }
          return compacted ? { messages: compacted } : {};
        },
        abortSignal: effectiveSignal,
        providerOptions: this.cfg.providerOptions,
        ...(this.cfg.temperature !== undefined && {
          temperature: this.cfg.temperature,
        }),
        ...(this.cfg.topP !== undefined && {
          topP: this.cfg.topP,
        }),
        ...(this.cfg.maxOutputTokens !== undefined && {
          maxOutputTokens: this.cfg.maxOutputTokens,
        }),
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step": {
            turnIndex++;
            messageId = `${agentId}:msg:${turnIndex}`;
            messageText = "";
            messageOpen = false;
            emit({ type: "turn_start", agentId, turnIndex });
            break;
          }
          case "text-delta": {
            const delta = part.text;
            if (!messageOpen) {
              messageOpen = true;
              emit({
                type: "message_start",
                agentId,
                messageId,
                role: "assistant",
              });
            }
            messageText += delta;
            emit({
              type: "message_update",
              agentId,
              messageId,
              deltaText: delta,
            });
            break;
          }
          case "reasoning-start": {
            // 空操作 —— 渲染端会在首个 delta 时惰性创建 reasoning 块。
            // 发出 `start` 会迫使每个 UI 各自维护标记;仅靠 delta 已足够。
            break;
          }
          case "reasoning-delta": {
            const delta = part.text;
            if (!delta) break;
            emit({
              type: "reasoning_update",
              agentId,
              messageId:
                messageId || `${agentId}:msg:${Math.max(turnIndex, 0)}`,
              deltaText: delta,
            });
            break;
          }
          case "reasoning-end": {
            emit({
              type: "reasoning_end",
              agentId,
              messageId:
                messageId || `${agentId}:msg:${Math.max(turnIndex, 0)}`,
            });
            break;
          }
          case "tool-call": {
            toolResults?.set(part.toolCallId, {
              name: part.toolName,
              success: true,
              result: undefined,
            });
            emit({
              type: "tool_execution_start",
              agentId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.input,
            });
            break;
          }
          case "tool-result": {
            const out = part.output as { success?: boolean; denied?: boolean };
            const success = !(out && out.success === false);
            toolResults?.set(part.toolCallId, {
              name: part.toolName,
              success,
              result: part.output,
            });
            emit({
              type: "tool_execution_end",
              agentId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: part.output,
              success,
              durationMs: 0,
            });
            break;
          }
          case "tool-error": {
            // `execute` 抛错的工具(MCP 超时 / 未连接、isError 结果、
            // 网络失败……)会在此处暴露,而非作为 `tool-result`。缺少这个
            // 分支时该 part 会被丢弃,渲染端的工具气泡将永远停留在"执行中"。
            // 镜像 tool-result 路径:发出一个 success=false 的终结性
            // `tool_execution_end`,使 UI 完成状态切换、模型也能看到失败。
            // AI SDK 仍会把错误回灌进循环,因此回合正常继续。
            const message =
              part.error instanceof Error
                ? part.error.message
                : typeof part.error === "string"
                  ? part.error
                  : String(part.error);
            const result = { success: false, error: message };
            toolResults?.set(part.toolCallId, {
              name: part.toolName,
              success: false,
              result,
            });
            emit({
              type: "tool_execution_end",
              agentId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result,
              success: false,
              durationMs: 0,
            });
            break;
          }
          case "finish-step": {
            const stepUsage = mapUsage(part.usage);
            if (messageOpen) {
              emit({
                type: "message_end",
                agentId,
                messageId,
                finalText: messageText,
                usage: stepUsage,
              });
              finalTextAccum += messageText;
              messageOpen = false;
            }
            lastFinishReason = part.finishReason;
            emit({
              type: "turn_end",
              agentId,
              turnIndex,
              reason: mapTurnEndReason(part.finishReason),
              usage: stepUsage,
            });
            // ── token 预算核算(每个 step 都计,含纯工具步)──────────────
            const stepTotal =
              stepUsage?.totalTokens ??
              (stepUsage?.inputTokens ?? 0) + (stepUsage?.outputTokens ?? 0);
            cumulativeTokens += stepTotal;
            if (
              this.cfg.maxTotalTokens &&
              cumulativeTokens >= this.cfg.maxTotalTokens &&
              !internalController.signal.aborted
            ) {
              stopReason = "token_budget";
              internalController.abort();
            } else if (
              part.finishReason === "tool-calls" &&
              turnIndex + 1 >= (this.cfg.maxStepsPerTurn ?? 20) &&
              !stopReason
            ) {
              // 模型还想继续(发了 tool-calls)但步数到顶被 stepCountIs 截停。
              // 仅记录,供可观测;不主动 abort(streamText 自身会停)。
              stopReason = "max_steps";
            }
            break;
          }
          case "error": {
            throw part.error;
          }
        }
      }

      // 从已 resolve 的 streamText 句柄上获取聚合的 usage 与 provider
      // metadata。它们是流消费完成后才 settle 的 promise。
      try {
        const usage = await result.totalUsage;
        totalUsage = mapUsage(usage);
      } catch {
        // 非关键
      }
      try {
        const meta = await result.providerMetadata;
        providerMetadata = meta as Record<string, unknown> | undefined;
      } catch {
        // 非关键
      }

      return {
        agentId,
        turnIndex,
        finalText: finalTextAccum,
        toolCalls: toolResults ? Array.from(toolResults.values()) : [],
        endReason: mapTurnEndReason(lastFinishReason),
        usage: totalUsage,
      };
    };

    const onRetry = (attempt: number, errorType: string) => {
      // 重试时重置累积文本 —— 助手消息重新开始。
      finalTextAccum = "";
      emit({
        type: "retry",
        agentId,
        turnIndex: -1,
        attempt,
        errorType,
      });
    };

    try {
      const maxReflections = this.cfg.maxReflections ?? 2;
      let reflectionAttempts = 0;
      let aborted: { reason: string } | undefined;
      // 每次迭代清空;当上一回合的 reflection 裁决 `forceNoTools` 为 true
      // 时由其设置。
      let passNoTools = false;

      while (true) {
        const captured = passNoTools;
        const summary = await withRetry(() => callStreamText(captured), {
          classify: this.cfg.classifyError,
          onRetry,
          signal: effectiveSignal,
        });

        // 命中**中止式**硬上限(token/wall)→ 停止后续 reflection,走正常
        // 收束路径。max_steps 只是可观测信号、不中止,必须继续走 reflection
        //(否则步数耗尽且模型还想调工具的回合会跳过 missingFinalAnswer 的
        // 强制收尾重试 —— 正是最需要它的时候)。
        if (stopReason === "token_budget" || stopReason === "wall_clock") break;
        if (!this.cfg.hooks?.reflect) break;
        if (effectiveSignal.aborted) break;
        if (reflectionAttempts >= maxReflections) break;

        const verdict = await this.cfg.hooks.reflect(summary, effectiveSignal);
        emit({
          type: "reflection_verdict",
          agentId,
          attempt: reflectionAttempts,
          verdict,
        });

        if (verdict.kind === "continue") break;
        if (verdict.kind === "abort") {
          aborted = { reason: verdict.reason };
          break;
        }
        // Retry:追加助手先前的回答(让模型把自己的输出作为上下文)
        // 以及 reflection 反馈。该反馈带有标签,使模型将其视为质量复审
        // 备注而非新的用户请求。当 `forceNoTools` 生效时,追加的备注会
        // 告知模型工具已关闭 —— 这段文案放在此处(而非规则里),以便它
        // 与上面实际的去工具操作保持配对。
        messages.push({ role: "assistant", content: summary.finalText });
        const toolsOffNote = verdict.forceNoTools
          ? "\n\n(Tools are disabled for the next attempt — answer from the information already gathered.)"
          : "";
        messages.push({
          role: "user",
          content: `[Reflection feedback — revise the previous answer]\n${verdict.feedback}${toolsOffNote}`,
        });
        passNoTools = verdict.forceNoTools === true;
        finalTextAccum = "";
        reflectionAttempts++;
      }

      if (aborted) {
        emit({
          type: "agent_end",
          agentId,
          status: "failed",
          error: { message: aborted.reason, type: "reflection_aborted" },
          totalUsage,
          providerMetadata,
          finalText: finalTextAccum,
        });
      } else if (this.cfg.signal?.aborted && !stopReason) {
        // 用户/父级在 reflect 间隙取消(streamText 内中止会走 catch)。
        emit({
          type: "agent_end",
          agentId,
          status: "cancelled",
          totalUsage,
          providerMetadata,
          finalText: finalTextAccum,
        });
      } else {
        emit({
          type: "agent_end",
          agentId,
          status: "completed",
          totalUsage,
          providerMetadata,
          finalText: finalTextAccum,
          stopReason,
        });
      }
    } catch (err) {
      // 暴露 AI SDK prompt-schema 错误的 zod cause,使异常的消息结构
      // 可从主进程日志中调试。SDK 把 ZodError 包了两层:
      // InvalidPromptError → TypeValidationError → ZodError。
      if (err instanceof Error && err.name === "AI_InvalidPromptError") {
        const c1 = (err as { cause?: unknown }).cause;
        const c2 = (c1 as { cause?: unknown } | undefined)?.cause;
        const issues = (c2 ?? c1) as { issues?: unknown } | undefined;
        console.error(
          "[agent-loop] AI SDK schema validation failed:",
          JSON.stringify(issues?.issues, null, 2),
        );
      }
      const isAbort = err instanceof Error && err.name === "AbortError";
      // 因 token/wall 硬上限触发的 internal abort:产出有效,视为完成 +
      // stopReason,而非 cancelled。
      if (isAbort && stopReason) {
        emit({
          type: "agent_end",
          agentId,
          status: "completed",
          totalUsage,
          providerMetadata,
          finalText: finalTextAccum,
          stopReason,
        });
      } else {
        const status: AgentEndStatus = isAbort ? "cancelled" : "failed";
        const classified =
          status === "failed" ? this.cfg.classifyError?.(err) : undefined;
        const errorPayload: ClassifiedAgentError | undefined =
          status === "failed"
            ? {
                message:
                  classified?.userMessage ||
                  (err instanceof Error ? err.message : String(err)),
                recoveryActions: classified?.recoveryActions,
                type: classified?.type ?? "unknown",
              }
            : undefined;
        emit({
          type: "agent_end",
          agentId,
          status,
          error: errorPayload,
          totalUsage,
          providerMetadata,
          finalText: finalTextAccum,
        });
      }
    } finally {
      if (wallTimer) clearTimeout(wallTimer);
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

interface RawUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  /** AI SDK v6 的嵌套形式(优先于已废弃的扁平字段)。 */
  outputTokenDetails?: {
    reasoningTokens?: number | null;
    textTokens?: number | null;
  } | null;
}

export function mapUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as RawUsage;
  const input = u.inputTokens ?? null;
  const output = u.outputTokens ?? null;
  const total =
    u.totalTokens ??
    (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  // 优先使用 v6 嵌套的 `outputTokenDetails.reasoningTokens`;对较旧的 SDK
  // 响应则回退到已废弃的扁平 `reasoningTokens` 字段。
  const reasoning =
    u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: u.cachedInputTokens ?? null,
    reasoningTokens: reasoning,
  };
}

function mapTurnEndReason(reason: string | undefined): TurnEndReason {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "stop":
    case "length":
    case "content-filter":
      return "finish";
    default:
      return "stop";
  }
}
