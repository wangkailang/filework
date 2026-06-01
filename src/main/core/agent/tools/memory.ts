/**
 * `updateMemory` 工具：让 Agent 把「可复用的持久事实」写入记忆(应用数据目录,
 * 非用户仓库),供后续任务直接读取,免去重复探索、节省 token。
 *
 * 记忆是「可寻址的离散条目」:每条带稳定主键 key + 作用域 scope + 分类 category。
 * 同一事实务必复用同一 key → upsert 覆盖,而不是换个措辞再写一条(根治重复)。
 *
 * 标记为 `safe`:只写应用数据、不触碰用户仓库文件,且作为可见的工具调用出现在
 * 对话流中,因此无需逐次审批。
 */

import { z } from "zod/v4";

import {
  clearUserMemory,
  clearWorkspaceMemory,
  containsSecret,
  forgetMemory,
  rememberMemory,
} from "../../workspace/workspace-memory";
import type { ToolDefinition } from "../tool-registry";

const updateMemorySchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      "Stable kebab-case identity for this fact (e.g. reply-style, build-commands, dir-layout). " +
        "To UPDATE an existing fact, reuse the SAME key shown in [brackets] in Workspace Memory — " +
        "this overwrites that entry instead of adding a near-duplicate.",
    ),
  text: z
    .string()
    .min(1)
    .describe(
      "ONE concise fact, a single sentence. Merge related info into one entry; " +
        "do not split slightly-reworded variants of the same fact into multiple memories.",
    ),
  scope: z
    .enum(["user", "workspace"])
    .describe(
      "user = personal preference that applies across ALL workspaces (reply language, tone, formatting). " +
        "workspace = fact about THIS project only (build/test commands, directory layout, conventions).",
    ),
  category: z
    .enum(["preference", "project", "convention", "reference"])
    .describe(
      "preference (how the user wants you to behave), project (what the project is / tech stack / layout), " +
        "convention (rules to follow in this repo), reference (pointers to external resources).",
    ),
  forget: z
    .boolean()
    .optional()
    .describe("Set true to DELETE the entry with this key instead of writing."),
});

export const updateMemoryTool: ToolDefinition<
  z.infer<typeof updateMemorySchema>,
  unknown
> = {
  name: "updateMemory",
  description:
    "Persist a durable, reusable fact so future tasks skip re-exploration. " +
    "BEFORE writing, consult the Workspace Memory already in your prompt: if a fact is already covered, " +
    "reuse its [key] to UPDATE it — never add a reworded duplicate. One fact per call. " +
    "WHEN: after exploring an unrecorded project (record a concise overview before finishing), " +
    "when the user states a lasting preference, or to correct stale/wrong memory (use forget=true to drop it). " +
    "WHAT: durable facts only — preferences, tech stack, layout, how to build/test/run, conventions. " +
    "NOT transient or task-specific details. " +
    "Use scope=user for personal preferences (apply everywhere) and scope=workspace for project facts. " +
    "Stored in app data, not your repository; hand-written AGENTS.md / CLAUDE.md are never modified.",
  safety: "safe",
  inputSchema: updateMemorySchema,
  execute: async (args, ctx) => {
    if (args.forget) {
      await forgetMemory(ctx.workspace, args.scope, args.key);
      return { success: true, action: "forget", key: args.key };
    }
    // 拒绝把疑似密钥/令牌写进记忆(否则会持久化并注入每轮提示)。
    if (containsSecret(args.text)) {
      return {
        success: false,
        action: "rejected",
        reason:
          "Refused to store: the text looks like it contains a secret/credential. Do not persist secrets in memory.",
      };
    }
    await rememberMemory(ctx.workspace, {
      key: args.key,
      scope: args.scope,
      category: args.category,
      text: args.text,
    });
    return {
      success: true,
      action: "remember",
      key: args.key,
      scope: args.scope,
    };
  },
};

const clearMemorySchema = z.object({
  scope: z
    .enum(["user", "workspace", "all"])
    .describe(
      "Which memory to wipe: user = personal preferences (all workspaces), " +
        "workspace = this project's memory, all = both. " +
        "When the user just says 'clear/reset memory' without specifying, use all.",
    ),
});

/**
 * `clearMemory` 工具：一次性清空某个作用域的全部记忆。
 *
 * 用户说「清理 / 清空 / 重置 memory」时用它,而不是逐条 forget key —— 后者容易
 * 漏删(尤其历史遗留的条目)。只清应用数据,人写 AGENTS.md / CLAUDE.md 不受影响。
 */
export const clearMemoryTool: ToolDefinition<
  z.infer<typeof clearMemorySchema>,
  unknown
> = {
  name: "clearMemory",
  description:
    "Wipe stored memory when the user asks to clear / forget / reset memory. " +
    "Deletes ALL entries in the chosen scope in ONE call — use this instead of forgetting keys one by one, " +
    "which misses entries. scope=user clears personal preferences (all workspaces), " +
    "scope=workspace clears this project's memory, scope=all clears both. " +
    "If the user just says 'clear memory' without a scope, use all. " +
    "Only app-data memory is affected; hand-written AGENTS.md / CLAUDE.md are never modified.",
  safety: "safe",
  inputSchema: clearMemorySchema,
  execute: async (args, ctx) => {
    if (args.scope === "user" || args.scope === "all") await clearUserMemory();
    if (args.scope === "workspace" || args.scope === "all")
      await clearWorkspaceMemory(ctx.workspace);
    return { success: true, action: "clear", scope: args.scope };
  },
};
