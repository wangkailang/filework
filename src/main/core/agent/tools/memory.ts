/**
 * `updateMemory` 工具：让 Agent 把「可复用的持久事实」写入工作目录记忆
 * （`AGENTS.md` 内的托管区块），供后续任务直接读取，免去重复探索、节省 token。
 *
 * 标记为 `safe`：只写入受标记保护的区块、不触碰用户手写内容，且作为可见的
 * 工具调用出现在对话流中，因此无需逐次审批 —— 低摩擦自记录正是该能力的意义。
 */

import { z } from "zod/v4";

import { updateWorkspaceMemory } from "../../workspace/workspace-memory";
import type { ToolDefinition } from "../tool-registry";

const updateMemorySchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      "Durable, reusable facts about THIS workspace, as concise Markdown bullets " +
        "(e.g. build/test commands, project layout, conventions). Not transient task state.",
    ),
  mode: z
    .enum(["append", "replace"])
    .optional()
    .describe(
      "append (default) adds to existing memory; replace overwrites the whole memory block.",
    ),
});

export const updateMemoryTool: ToolDefinition<
  z.infer<typeof updateMemorySchema>,
  unknown
> = {
  name: "updateMemory",
  description:
    "Persist durable, reusable facts about the current workspace to its AGENTS.md memory " +
    "(a managed block; hand-written content is never touched). Use this when you learn " +
    "something worth remembering across tasks — package manager, how to run tests/build, " +
    "directory layout, conventions — so future tasks skip re-exploration. Do NOT store " +
    "transient or task-specific details.",
  safety: "safe",
  inputSchema: updateMemorySchema,
  execute: async (args, ctx) => {
    await updateWorkspaceMemory(ctx.workspace, args.content, args.mode);
    return { success: true, mode: args.mode ?? "append" };
  },
};
