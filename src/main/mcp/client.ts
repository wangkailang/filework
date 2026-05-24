/**
 * Thin wrapper around one MCP `Client` instance: handles transport
 * construction (stdio | streamable HTTP), connect/disconnect, the
 * post-connect `listTools` pull, and re-exposes `callTool` with
 * `AbortSignal` forwarding.
 *
 * `callTool` returns the raw `CallToolResult` from the SDK — the
 * tool-bridge layer is responsible for shaping it into the structured-
 * content form the agent loop expects.
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
  /** Called with the latest tool list after every successful refresh. */
  onToolsChanged?: (tools: McpToolDescriptor[]) => void;
  /** Notified when the transport reports a fatal error or remote close. */
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
      // Closing a half-broken transport can throw — drop the reference
      // either way so reconnect attempts aren't blocked.
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
        // Inherit so the user sees server logs in the dev console — same
        // behavior as Claude Desktop / Cursor.
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
 * Replace `${env:VAR}` placeholders with values from `process.env`.
 * Unknown vars expand to the empty string — mirrors Claude Desktop /
 * VS Code behavior so the server-side surfaces its own clearer error
 * (e.g. "missing API key") rather than a generic config-parse failure.
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
