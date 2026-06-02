/**
 * 进程级的 MCP 服务器注册表。
 *
 * 每一行持久化的 `mcp_servers` 记录对应一个 `McpClient`。manager
 * 负责连接/重连生命周期,缓存最新的工具列表,并为
 * `buildAgentToolRegistry` 暴露 `getActiveToolDefs()`,使 MCP 工具
 * 汇入与 filework 内置工具相同的 `ToolRegistry`。
 *
 * 渲染进程状态 UI 监听 `mcp:server-status-changed` ——
 * `notifyStatus()` 在连接/断开/错误/刷新时广播,使设置面板
 * 无需轮询即可点亮绿/红状态点。
 */

import type { Tool as McpToolDescriptor } from "@modelcontextprotocol/sdk/types.js";
import { BrowserWindow } from "electron";

import type { ToolDefinition } from "../core/agent/tool-registry";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  type McpServer,
  type McpServerInput,
  updateMcpServer,
} from "../db";
import { McpClient } from "./client";
import { buildMcpToolDefs } from "./tool-bridge";
import type { McpServerStatus, McpToolSummary } from "./types";

interface Entry {
  config: McpServer;
  client: McpClient;
  status: McpServerStatus;
}

class McpManager {
  private entries = new Map<string, Entry>();

  /** 从 SQLite 拉取所有记录到内存映射中。 */
  init(): void {
    this.entries.clear();
    for (const config of listMcpServers()) {
      this.entries.set(config.id, this.buildEntry(config));
    }
  }

  /** 打开每一个已启用的服务器。失败按服务器隔离。 */
  async connectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.config.enabled) tasks.push(this.connectEntry(entry));
    }
    await Promise.allSettled(tasks);
  }

  async disconnectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      tasks.push(entry.client.disconnect());
    }
    await Promise.allSettled(tasks);
  }

  async addServer(input: McpServerInput): Promise<McpServer> {
    const row = createMcpServer(input);
    const entry = this.buildEntry(row);
    this.entries.set(row.id, entry);
    if (row.enabled) {
      // 发射后不管 —— UI 通过状态广播看到结果。
      void this.connectEntry(entry);
    }
    this.notifyStatusList();
    return row;
  }

  async updateServer(
    id: string,
    updates: Partial<McpServerInput>,
  ): Promise<McpServer | null> {
    updateMcpServer(id, updates);
    const fresh = getMcpServer(id);
    if (!fresh) return null;
    const existing = this.entries.get(id);
    // 替换并重连 —— 大多数字段(command/args/env/url/headers)
    // 都会影响传输层,因此完整重建是更安全的默认做法。
    if (existing) await existing.client.disconnect();
    const next = this.buildEntry(fresh);
    this.entries.set(id, next);
    if (fresh.enabled) void this.connectEntry(next);
    this.notifyStatusList();
    return fresh;
  }

  async deleteServer(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) await entry.client.disconnect();
    this.entries.delete(id);
    deleteMcpServer(id);
    this.notifyStatusList();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    updateMcpServer(id, { enabled });
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.config = { ...entry.config, enabled };
    if (enabled) {
      void this.connectEntry(entry);
    } else {
      await entry.client.disconnect();
      entry.status.connected = false;
      entry.status.connecting = false;
      entry.status.toolCount = 0;
      this.notifyStatus(id);
    }
  }

  async setTrusted(id: string, trusted: boolean): Promise<void> {
    updateMcpServer(id, { trusted });
    const entry = this.entries.get(id);
    if (entry) entry.config = { ...entry.config, trusted };
  }

  async reconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await entry.client.disconnect();
    if (entry.config.enabled) await this.connectEntry(entry);
  }

  /**
   * 探测一个服务器配置而不持久化它 —— 供设置 UI 的
   * "Test connection" 按钮使用。
   */
  async testConnection(input: McpServerInput): Promise<{
    ok: boolean;
    toolCount?: number;
    tools?: string[];
    error?: string;
  }> {
    const fake: McpServer = {
      id: "__test__",
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      env: input.env ?? {},
      cwd: input.cwd ?? null,
      url: input.url ?? null,
      headers: input.headers ?? {},
      enabled: true,
      trusted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const client = new McpClient(fake);
    try {
      await client.connect();
      const tools = client.getTools();
      await client.disconnect();
      return {
        ok: true,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
      };
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  listServersWithStatus(): Array<McpServer & { status: McpServerStatus }> {
    return Array.from(this.entries.values()).map((e) => ({
      ...e.config,
      status: e.status,
    }));
  }

  getStatus(id: string): McpServerStatus | null {
    return this.entries.get(id)?.status ?? null;
  }

  listTools(id: string): McpToolSummary[] {
    const entry = this.entries.get(id);
    if (!entry) return [];
    return entry.client.getTools().map((t) => ({
      name: t.name,
      description: t.description ?? "",
      fullName: `mcp__${slug(entry.config.name)}__${t.name}`,
    }));
  }

  /** 每一个已连接且已启用的服务器的工具定义。 */
  getActiveToolDefs(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled || !entry.status.connected) continue;
      defs.push(...buildMcpToolDefs(entry.config, entry.client));
    }
    return defs;
  }

  // ---------- 内部实现 ----------

  private buildEntry(config: McpServer): Entry {
    const status: McpServerStatus = {
      id: config.id,
      connected: false,
      connecting: false,
      toolCount: 0,
      lastError: null,
      lastConnectedAt: null,
    };
    const client = new McpClient(config, {
      onToolsChanged: (tools) => {
        status.toolCount = tools.length;
        this.notifyStatus(config.id);
      },
      onTransportClose: (err) => {
        status.connected = false;
        status.connecting = false;
        status.toolCount = 0;
        status.lastError = err ? err.message : null;
        this.notifyStatus(config.id);
      },
    });
    return { config, client, status };
  }

  private async connectEntry(entry: Entry): Promise<void> {
    if (entry.status.connecting) return;
    entry.status.connecting = true;
    entry.status.lastError = null;
    this.notifyStatus(entry.config.id);
    try {
      await entry.client.connect();
      entry.status.connected = true;
      entry.status.connecting = false;
      entry.status.toolCount = entry.client.getTools().length;
      entry.status.lastConnectedAt = new Date().toISOString();
    } catch (err) {
      entry.status.connected = false;
      entry.status.connecting = false;
      entry.status.toolCount = 0;
      entry.status.lastError = err instanceof Error ? err.message : String(err);
    }
    this.notifyStatus(entry.config.id);
  }

  private notifyStatus(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    broadcast("mcp:server-status-changed", {
      id,
      status: entry.status,
    });
  }

  private notifyStatusList(): void {
    broadcast("mcp:server-list-changed", null);
  }
}

const broadcast = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const slug = (name: string): string => {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "server";
};

export const mcpManager = new McpManager();
export { slug as slugForMcpServerName };
export type McpToolDescriptorT = McpToolDescriptor;
