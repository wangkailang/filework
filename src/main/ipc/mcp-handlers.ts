/**
 * IPC: mcp:* — manage user-configured MCP (Model Context Protocol) servers.
 *
 * All channels delegate to the singleton `mcpManager`, which owns the
 * live connections and broadcasts `mcp:server-status-changed` /
 * `mcp:server-list-changed` events back to the renderer.
 *
 * The `importJson` channel accepts the Claude Desktop / Cursor config
 * format `{ "mcpServers": { "<name>": { "command": ..., "args": [...],
 * "env": {...} } } }` so users can paste an existing config without
 * editing it.
 */

import { ipcMain } from "electron";

import { mcpManager } from "../mcp/manager";
import type { McpServer, McpServerInput, McpTransport } from "../mcp/types";

type JsonRecord = Record<string, unknown>;

const asRecord = (v: unknown): JsonRecord | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

const asStringRecord = (v: unknown): Record<string, string> => {
  const rec = asRecord(v);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
};

const sanitizeInput = (raw: unknown): McpServerInput => {
  const rec = asRecord(raw) ?? {};
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) throw new Error("name is required");
  const transport =
    rec.transport === "http" ? ("http" as const) : ("stdio" as const);
  const trusted = rec.trusted === true;
  const enabled = rec.enabled !== false;
  return {
    name,
    transport,
    command: typeof rec.command === "string" ? rec.command : null,
    args: asStringArray(rec.args),
    env: asStringRecord(rec.env),
    cwd: typeof rec.cwd === "string" ? rec.cwd : null,
    url: typeof rec.url === "string" ? rec.url : null,
    headers: asStringRecord(rec.headers),
    enabled,
    trusted,
  };
};

/**
 * Parse Claude Desktop / Cursor / VS Code `mcpServers` JSON into our
 * `McpServerInput[]` shape. Detects transport heuristically: presence
 * of `url` → http, otherwise stdio. Accepts both the top-level
 * `{ mcpServers: {...} }` envelope and a bare object.
 */
const parseImportJson = (raw: unknown): McpServerInput[] => {
  const rec = asRecord(raw);
  if (!rec) throw new Error("Invalid JSON: expected an object");
  const servers = asRecord(rec.mcpServers) ?? rec;
  const out: McpServerInput[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const transport: McpTransport =
      typeof entry.url === "string" ? "http" : "stdio";
    out.push({
      name,
      transport,
      command: typeof entry.command === "string" ? entry.command : null,
      args: asStringArray(entry.args),
      env: asStringRecord(entry.env),
      cwd: typeof entry.cwd === "string" ? entry.cwd : null,
      url: typeof entry.url === "string" ? entry.url : null,
      headers: asStringRecord(entry.headers),
      enabled: entry.enabled !== false,
      trusted: entry.trusted === true,
    });
  }
  return out;
};

export const registerMcpHandlers = (): void => {
  ipcMain.handle("mcp:listServers", async () =>
    mcpManager.listServersWithStatus(),
  );

  ipcMain.handle(
    "mcp:addServer",
    async (_event, payload: unknown): Promise<McpServer> => {
      const input = sanitizeInput(payload);
      return mcpManager.addServer(input);
    },
  );

  ipcMain.handle(
    "mcp:updateServer",
    async (_event, payload: { id: string; updates: unknown }) => {
      if (!payload?.id) throw new Error("id is required");
      const updates = asRecord(payload.updates) ?? {};
      const partial: Partial<McpServerInput> = {};
      if ("name" in updates && typeof updates.name === "string")
        partial.name = updates.name;
      if (
        "transport" in updates &&
        (updates.transport === "stdio" || updates.transport === "http")
      )
        partial.transport = updates.transport;
      if ("command" in updates)
        partial.command =
          typeof updates.command === "string" ? updates.command : null;
      if ("args" in updates) partial.args = asStringArray(updates.args);
      if ("env" in updates) partial.env = asStringRecord(updates.env);
      if ("cwd" in updates)
        partial.cwd = typeof updates.cwd === "string" ? updates.cwd : null;
      if ("url" in updates)
        partial.url = typeof updates.url === "string" ? updates.url : null;
      if ("headers" in updates)
        partial.headers = asStringRecord(updates.headers);
      if ("enabled" in updates) partial.enabled = updates.enabled === true;
      if ("trusted" in updates) partial.trusted = updates.trusted === true;
      return mcpManager.updateServer(payload.id, partial);
    },
  );

  ipcMain.handle(
    "mcp:deleteServer",
    async (_event, payload: { id: string }) => {
      if (!payload?.id) throw new Error("id is required");
      await mcpManager.deleteServer(payload.id);
      return true;
    },
  );

  ipcMain.handle(
    "mcp:setEnabled",
    async (_event, payload: { id: string; enabled: boolean }) => {
      if (!payload?.id) throw new Error("id is required");
      await mcpManager.setEnabled(payload.id, payload.enabled === true);
      return true;
    },
  );

  ipcMain.handle(
    "mcp:setTrusted",
    async (_event, payload: { id: string; trusted: boolean }) => {
      if (!payload?.id) throw new Error("id is required");
      await mcpManager.setTrusted(payload.id, payload.trusted === true);
      return true;
    },
  );

  ipcMain.handle("mcp:reconnect", async (_event, payload: { id: string }) => {
    if (!payload?.id) throw new Error("id is required");
    await mcpManager.reconnect(payload.id);
    return true;
  });

  ipcMain.handle("mcp:listTools", async (_event, payload: { id: string }) => {
    if (!payload?.id) return [];
    return mcpManager.listTools(payload.id);
  });

  ipcMain.handle(
    "mcp:importJson",
    async (
      _event,
      payload: { json: string },
    ): Promise<{ added: number; errors: string[] }> => {
      if (!payload?.json) return { added: 0, errors: ["Empty JSON"] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.json);
      } catch (err) {
        return {
          added: 0,
          errors: [
            `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          ],
        };
      }
      const inputs = parseImportJson(parsed);
      const errors: string[] = [];
      let added = 0;
      for (const input of inputs) {
        try {
          await mcpManager.addServer(input);
          added += 1;
        } catch (err) {
          errors.push(
            `${input.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { added, errors };
    },
  );

  ipcMain.handle("mcp:testConnection", async (_event, payload: unknown) => {
    const input = sanitizeInput(payload);
    return mcpManager.testConnection(input);
  });
};
