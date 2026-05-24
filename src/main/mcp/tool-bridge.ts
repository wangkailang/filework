/**
 * Adapter that exposes MCP tools as filework `ToolDefinition`s so they
 * drop into the existing `ToolRegistry` and ride the same execution
 * path as built-in tools (signal forwarding, approval hook, etc.).
 *
 * Naming convention: `mcp__<serverSlug>__<toolName>` — matches Claude
 * Code / Cursor so users can copy `allowed-tools` lists between tools.
 *
 * Safety: `trusted=true` on the server config → tools run as `safe`
 * (no approval prompt). Default `destructive` so the existing
 * `beforeToolCall` gate catches arbitrary MCP shells, db drops, etc.
 *
 * Call results: the SDK returns `CallToolResult { content, isError,
 * structuredContent? }`. We surface the whole object back to the model
 * — text blocks render well; image/resource blocks stay in the JSON so
 * a downstream renderer can pick them up. `isError=true` is translated
 * into a thrown error so the agent loop treats it as a failed tool
 * call (the SDK ai-sdk wrapper turns thrown errors into `tool-error`).
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
 * One `ToolDefinition` per tool the server exposes. The MCP descriptor's
 * `inputSchema` is mapped through `jsonSchemaToZodObject` so the ai-sdk
 * gets a Zod schema and can validate/serialize args natively.
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
      // Pass the SDK's result through verbatim. The ai-sdk serializes
      // this into the tool-result message; the model sees both `content`
      // blocks and `structuredContent` when present.
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
