/**
 * `updateMemory` 工具：让 Agent 把「可复用的持久事实」写入工作目录记忆
 * （应用数据目录,非用户仓库),供后续任务直接读取,免去重复探索、节省 token。
 *
 * 标记为 `safe`:只写应用数据、不触碰用户仓库文件,且作为可见的工具调用出现在
 * 对话流中,因此无需逐次审批 —— 低摩擦自记录正是该能力的意义。
 *
 * 「何时调用 / 记什么」的指引放在下面的 description(L2,模型考虑该工具时才
 * 关注),系统提示词只在确实有记忆时才注入记忆本身,保持最小化。
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
    "Persist durable, reusable facts about the current workspace so future tasks skip re-exploration. " +
    "WHEN: if you explored the project to answer (listing directories, reading config / manifests) and " +
    "it had no saved memory yet, record a concise overview before finishing; also call this to correct " +
    "memory that has become stale or wrong. " +
    "WHAT: durable facts only — what the project is, tech stack, directory layout, how to build / test / run, " +
    "conventions. NOT transient or task-specific details. " +
    "Stored in app data, not your repository; hand-written AGENTS.md / CLAUDE.md are never modified. " +
    "mode=append (default) adds to existing memory; mode=replace overwrites it.",
  safety: "safe",
  inputSchema: updateMemorySchema,
  execute: async (args, ctx) => {
    await updateWorkspaceMemory(ctx.workspace, args.content, args.mode);
    return { success: true, mode: args.mode ?? "append" };
  },
};
