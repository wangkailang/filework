/**
 * 工具注册表 —— 持有工具定义,并将其转换为 ai-sdk 的 Tool
 * 形态,附带可选的 `beforeToolCall` 门控。
 *
 * 工具与领域无关:它们接收一个 `ToolContext`,其中携带
 * 当前的 `Workspace`(用于文件系统 / exec / scm)、中止信号
 * 以及 toolCallId。每个工具的 `execute()` 调用 `ctx.workspace.*`
 * 而非裸的 `node:fs`,因此同一份工具实现既适用于今天的 `LocalWorkspace`,
 * 也适用于未来的 `GitHubWorkspace`。
 *
 * 参数校验由每个工具自己的 `inputSchema`(一个 `z.ZodType`)负责。
 */

import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { Tool, ToolExecutionOptions } from "ai";
import { tool as defineAiTool } from "ai";
import type { z } from "zod/v4";

import { type Workspace, WorkspaceEscapeError } from "../workspace/types";
import { capToolResult } from "./cap-tool-result";

export interface ToolContext {
  workspace: Workspace;
  /** 合并后的信号:AI-SDK 中止 + 任务级中止。 */
  signal: AbortSignal;
  toolCallId: string;
}

export interface BeforeToolCallDecision {
  allow: boolean;
  /** 当 allow=false 时呈现给模型的可选原因。 */
  reason?: string;
}

export type BeforeToolCallHook = (
  call: {
    toolName: string;
    toolCallId: string;
    args: unknown;
  },
  ctx: ToolContext,
) => Promise<BeforeToolCallDecision>;

/**
 * 在每个非 `createPlan` 工具执行前运行的门控。返回 `true` 表示放行
 * (没有待审批的计划,或计划已被批准),返回 `false` 表示拒绝(用户
 * 拒绝了一个仍在待审批的计划)。它让一个等待审批的草稿计划阻塞
 * 所有其他工具 —— 这是叠加在「禁用并行工具调用」之上的一层防御,
 * 而后者才是真正防止同一步骤内某个同级工具与计划产生竞态的机制。
 */
export type PlanGateHook = (toolName: string) => Promise<boolean>;

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /**
   * Optional schema for the raw tool output. When present, the AI SDK can
   * validate UI/tool-result parts while the model-facing projection remains
   * controlled by toModelOutput.
   */
  outputSchema?: z.ZodType<TOutput>;
  /**
   * Project the raw tool output down to the content that should be fed back to
   * the model. Useful for rich or large outputs where the UI/trace wants full
   * data but the model only needs a summary.
   */
  toModelOutput?: (options: {
    toolCallId: string;
    input: TInput;
    output: TOutput;
  }) => ToolResultOutput | PromiseLike<ToolResultOutput>;
  /**
   * `safe` 工具无条件执行。`destructive` 工具在执行前
   * 会(在配置了的情况下)经由 `beforeToolCall` 路由。
   */
  safety: "safe" | "destructive";
  execute: (args: TInput, ctx: ToolContext) => Promise<TOutput>;
}

export interface ToolDeniedResult {
  success: false;
  denied: true;
  reason: string;
}

export interface ToolObservedResult {
  toolName: string;
  toolCallId: string;
  args: unknown;
  rawOutput: unknown;
}

export type ToolResultObserver = (
  result: ToolObservedResult,
) => void | Promise<void>;

function recoverableToolError(error: unknown): unknown | null {
  if (error instanceof WorkspaceEscapeError) {
    return {
      success: false,
      error: error.message,
      hint: "This path is outside the workspace. Write scratch files under the workspace root (for example .filework/tmp/...) and run them with cwd plus a relative path.",
    };
  }
  return null;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 将所有已注册工具转换为 ai-sdk 兼容的 `Tool` 映射。
   *
   * `ctxFactory` 为每次调用生成一个全新的 `ToolContext`,因此每次
   * 调用都获得各自的 toolCallId。当提供了 `beforeToolCall` 时,
   * destructive 工具会经由它路由;若被拒绝,工具将以
   * `ToolDeniedResult` 返回而不执行。
   */
  toAiSdkTools(opts: {
    ctxFactory: (call: { toolName: string; toolCallId: string }) => ToolContext;
    beforeToolCall?: BeforeToolCallHook;
    planGate?: PlanGateHook;
    onToolResult?: ToolResultObserver;
  }): Record<string, Tool> {
    const result: Record<string, Tool> = {};
    for (const def of this.tools.values()) {
      result[def.name] = this.toAiSdkTool(def, opts);
    }
    return result;
  }

  private toAiSdkTool(
    def: ToolDefinition,
    opts: {
      ctxFactory: (call: {
        toolName: string;
        toolCallId: string;
      }) => ToolContext;
      beforeToolCall?: BeforeToolCallHook;
      planGate?: PlanGateHook;
      onToolResult?: ToolResultObserver;
    },
  ): Tool {
    return defineAiTool({
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.outputSchema !== undefined && { outputSchema: def.outputSchema }),
      ...(def.toModelOutput !== undefined && {
        toModelOutput: def.toModelOutput,
      }),
      execute: async (
        args: unknown,
        execOpts: ToolExecutionOptions<unknown>,
      ) => {
        const ctx = opts.ctxFactory({
          toolName: def.name,
          toolCallId: execOpts.toolCallId,
        });

        // 等待审批的草稿计划会阻塞其他所有工具,直到
        // 用户批准(或拒绝 → 否决)。createPlan 自身豁免。
        if (def.name !== "createPlan" && opts.planGate) {
          const proceed = await opts.planGate(def.name);
          if (!proceed) {
            const denied: ToolDeniedResult = {
              success: false,
              denied: true,
              reason: "计划被拒绝,未执行",
            };
            return denied;
          }
        }

        if (def.safety === "destructive" && opts.beforeToolCall) {
          const decision = await opts.beforeToolCall(
            {
              toolName: def.name,
              toolCallId: execOpts.toolCallId,
              args,
            },
            ctx,
          );
          if (!decision.allow) {
            const denied: ToolDeniedResult = {
              success: false,
              denied: true,
              reason: decision.reason ?? "Tool call denied",
            };
            return denied;
          }
        }

        // 通用来源上限:在任何工具的结果进入模型上下文之前对其设界,
        // 使得任何工具(内置 / web / MCP)都无法撑爆消费它的
        // 那个步骤。参见 cap-tool-result.ts。
        let rawOutput: unknown;
        try {
          rawOutput = await def.execute(args as never, ctx);
        } catch (error) {
          const recovered = recoverableToolError(error);
          if (recovered == null) throw error;
          rawOutput = recovered;
        }
        await opts.onToolResult?.({
          toolName: def.name,
          toolCallId: execOpts.toolCallId,
          args,
          rawOutput,
        });

        // Tools that opt into a declared output schema or toModelOutput are
        // intentionally exposing their raw output to downstream UI/trace
        // consumers. The model-facing payload can still be minimized by
        // toModelOutput, which the AI SDK applies after execute resolves.
        if (def.outputSchema !== undefined || def.toModelOutput !== undefined) {
          return rawOutput;
        }
        return capToolResult(rawOutput);
      },
    });
  }
}
