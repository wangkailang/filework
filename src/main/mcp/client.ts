/**
 * 对单个 MCP `Client` 实例的轻量封装:负责传输层
 * 构造(stdio | streamable HTTP)、连接/断开、连接后的
 * `listTools` 拉取,并重新暴露带 `AbortSignal` 转发的
 * `callTool`。
 *
 * `callTool` 直接返回 SDK 的原始 `CallToolResult` ——
 * 由 tool-bridge 层负责将其整理成 agent 循环所期望的
 * 结构化内容形式。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  Tool as McpToolDescriptor,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpServer } from "./types";

export interface McpClientOptions {
  /** 每次成功刷新后,以最新的工具列表回调。 */
  onToolsChanged?: (tools: McpToolDescriptor[]) => void;
  /** 当传输层报告致命错误或远端关闭时通知。 */
  onTransportClose?: (err: Error | null) => void;
}

export class McpClient {
  private client: Client | null = null;
  private tools: McpToolDescriptor[] = [];

  constructor(
    private readonly config: McpServer,
    private readonly options: McpClientOptions = {},
  ) {}

  getTools(): McpToolDescriptor[] {
    return this.tools;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.client) return;

    const client = new Client(
      { name: "filework-desktop", version: "0.1.0" },
      { capabilities: {} },
    );

    const transport = this.buildTransport();
    transport.onclose = () => {
      this.client = null;
      this.tools = [];
      this.options.onTransportClose?.(null);
    };
    transport.onerror = (err) => {
      this.options.onTransportClose?.(err);
    };

    await client.connect(transport);
    this.client = client;
    await this.refreshTools();
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } catch {
      // 关闭一个半损坏的传输层可能抛错 —— 无论如何都丢弃
      // 引用,以免阻塞后续的重连尝试。
    }
    this.client = null;
    this.tools = [];
  }

  async refreshTools(): Promise<McpToolDescriptor[]> {
    if (!this.client) return [];
    const res = await this.client.listTools();
    this.tools = res.tools;
    this.options.onToolsChanged?.(this.tools);
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error(`MCP server "${this.config.name}" is not connected`);
    }
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { signal },
    );
    return result as CallToolResult;
  }

  private buildTransport():
    | StdioClientTransport
    | StreamableHTTPClientTransport {
    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error(
          `MCP server "${this.config.name}": stdio transport requires "command"`,
        );
      }
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: expandEnvRecord(this.config.env),
        cwd: this.config.cwd ?? undefined,
        // 继承 stderr,让用户在开发控制台看到服务端日志 ——
        // 与 Claude Desktop / Cursor 行为一致。
        stderr: "inherit",
      });
    }

    if (!this.config.url) {
      throw new Error(
        `MCP server "${this.config.name}": http transport requires "url"`,
      );
    }
    const headers = expandEnvRecord(this.config.headers);
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers },
    });
  }
}

/**
 * 将 `${env:VAR}` 占位符替换为 `process.env` 中的值。
 * 未知变量展开为空字符串 —— 与 Claude Desktop /
 * VS Code 行为一致,从而让服务端给出更清晰的自身错误
 * (例如 "missing API key"),而非通用的配置解析失败。
 */
export const expandEnvRecord = (
  record: Record<string, string>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = v.replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_m, name) =>
      typeof process.env[name] === "string"
        ? (process.env[name] as string)
        : "",
    );
  }
  return out;
};
