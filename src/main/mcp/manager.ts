/**
 * Per-process MCP server registry.
 *
 * One `McpClient` per persisted `mcp_servers` row. The manager owns the
 * connect/reconnect lifecycle, caches the latest tool list, and exposes
 * `getActiveToolDefs()` for `buildAgentToolRegistry` so MCP tools flow
 * into the same `ToolRegistry` as filework's built-ins.
 *
 * Renderer status UI listens on `mcp:server-status-changed` —
 * `notifyStatus()` broadcasts on connect/disconnect/error/refresh so the
 * settings panel can light up the green/red dots without polling.
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

  /** Pull all rows from SQLite into the in-memory map. */
  init(): void {
    this.entries.clear();
    for (const config of listMcpServers()) {
      this.entries.set(config.id, this.buildEntry(config));
    }
  }

  /** Open every enabled server. Failures are isolated per server. */
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
      // Fire-and-forget — UI sees the result via the status broadcast.
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
    // Replace and reconnect — most fields (command/args/env/url/headers)
    // affect the transport, so a full rebuild is the safe default.
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
   * Probe a server config without persisting it — used by the
   * settings UI's "Test connection" button.
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

  /** Tool definitions for every connected, enabled server. */
  getActiveToolDefs(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled || !entry.status.connected) continue;
      defs.push(...buildMcpToolDefs(entry.config, entry.client));
    }
    return defs;
  }

  // ---------- internals ----------

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
