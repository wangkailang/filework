/**
 * Tool registry — owns tool definitions and converts them to ai-sdk Tool
 * shape with optional `beforeToolCall` gating.
 *
 * Tools are domain-neutral: they receive a `ToolContext` carrying the
 * active `Workspace` (for filesystem / exec / scm), the abort signal,
 * and the toolCallId. Each tool's `execute()` calls into `ctx.workspace.*`
 * rather than raw `node:fs` so the same tool body works for `LocalWorkspace`
 * today and a future `GitHubWorkspace` tomorrow.
 *
 * Args validation is owned by each tool's `inputSchema` (a `z.ZodType`).
 */

import type { Tool, ToolExecutionOptions } from "ai";
import { tool as defineAiTool } from "ai";
import type { z } from "zod/v4";

import type { Workspace } from "../workspace/types";

export interface ToolContext {
  workspace: Workspace;
  /** Combined signal: AI-SDK abort + task-level abort. */
  signal: AbortSignal;
  toolCallId: string;
}

export interface BeforeToolCallDecision {
  allow: boolean;
  /** Optional reason surfaced to the model when allow=false. */
  reason?: string;
}

export type BeforeToolCallHook = (
  call: { toolName: string; toolCallId: string; args: unknown },
  ctx: ToolContext,
) => Promise<BeforeToolCallDecision>;

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /**
   * `safe` tools run unconditionally. `destructive` tools are routed
   * through `beforeToolCall` (when configured) before execution.
   */
  safety: "safe" | "destructive";
  execute: (args: TInput, ctx: ToolContext) => Promise<TOutput>;
}

export interface ToolDeniedResult {
  success: false;
  denied: true;
  reason: string;
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
   * Convert all registered tools to ai-sdk-compatible `Tool` map.
   *
   * `ctxFactory` produces a fresh `ToolContext` per call so each
   * invocation gets its own toolCallId. When `beforeToolCall` is
   * supplied, destructive tools route through it; if denied, the tool
   * resolves with a `ToolDeniedResult` instead of executing.
   */
  toAiSdkTools(opts: {
    ctxFactory: (call: { toolName: string; toolCallId: string }) => ToolContext;
    beforeToolCall?: BeforeToolCallHook;
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
    },
  ): Tool {
    return defineAiTool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (args: unknown, execOpts: ToolExecutionOptions) => {
        const ctx = opts.ctxFactory({
          toolName: def.name,
          toolCallId: execOpts.toolCallId,
        });

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

        return def.execute(args as never, ctx);
      },
    });
  }
}
