/**
 * 适配器,将 MCP 工具暴露为 filework 的 `ToolDefinition`,使其
 * 接入既有的 `ToolRegistry`,并走与内置工具相同的执行
 * 路径(signal 转发、审批钩子等)。
 *
 * 命名约定:`mcp__<serverSlug>__<toolName>` —— 与 Claude
 * Code / Cursor 一致,便于用户在不同工具间复制 `allowed-tools` 列表。
 *
 * 安全性:服务器配置上的 `trusted=true` → 工具以 `safe` 运行
 * (不弹审批)。默认 `destructive`,以便既有的
 * `beforeToolCall` 门控拦住任意的 MCP shell、删库等操作。
 *
 * 调用结果:SDK 返回 `CallToolResult { content, isError,
 * structuredContent? }`。我们把整个对象原样回传给模型
 * —— 文本块渲染良好;图像/资源块保留在 JSON 中,以便
 * 下游渲染器拾取。`isError=true` 会被转换为抛出的错误,使
 * agent 循环将其视为一次失败的工具调用(SDK 的 ai-sdk 封装
 * 会把抛出的错误转成 `tool-error`)。
 */

import type {
  CallToolResult,
  Tool as McpToolDescriptor,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition } from "../core/agent/tool-registry";
import type { McpClient } from "./client";
import { jsonSchemaToZodObject } from "./json-schema-to-zod";
import { slugForMcpServerName } from "./manager";
import type { McpServer } from "./types";

const mcpToolName = (serverName: string, toolName: string): string =>
  `mcp__${slugForMcpServerName(serverName)}__${toolName}`;

const fallbackDescription = (serverName: string, toolName: string): string =>
  `MCP tool "${toolName}" from server "${serverName}"`;

/**
 * 服务器暴露的每个工具对应一个 `ToolDefinition`。MCP 描述符的
 * `inputSchema` 经由 `jsonSchemaToZodObject` 映射,使 ai-sdk
 * 拿到 Zod schema 并能原生地校验/序列化参数。
 */
export const buildMcpToolDefs = (
  config: McpServer,
  client: McpClient,
): ToolDefinition[] =>
  client.getTools().map((tool) => buildOne(config, client, tool));

const buildOne = (
  config: McpServer,
  client: McpClient,
  tool: McpToolDescriptor,
): ToolDefinition => {
  const name = mcpToolName(config.name, tool.name);
  return {
    name,
    description:
      tool.description ?? fallbackDescription(config.name, tool.name),
    inputSchema: jsonSchemaToZodObject(
      tool.inputSchema as Record<string, unknown> | undefined,
    ),
    safety: config.trusted ? "safe" : "destructive",
    execute: async (args, ctx) => {
      const result: CallToolResult = await client.callTool(
        tool.name,
        (args ?? {}) as Record<string, unknown>,
        ctx.signal,
      );
      if (result.isError) {
        throw new Error(extractErrorText(result));
      }
      // 原样透传 SDK 的结果。ai-sdk 会将其序列化进
      // tool-result 消息;当存在时,模型同时能看到 `content`
      // 块与 `structuredContent`。
      return {
        content: result.content,
        structuredContent: result.structuredContent,
      };
    },
  };
};

const extractErrorText = (result: CallToolResult): string => {
  const texts: string[] = [];
  for (const block of result.content ?? []) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text"
    ) {
      const t = (block as { text?: string }).text;
      if (typeof t === "string") texts.push(t);
    }
  }
  return texts.length > 0 ? texts.join("\n") : "MCP tool returned an error";
};

export const __testing = { mcpToolName };
