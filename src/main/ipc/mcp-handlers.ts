/**
 * IPC: mcp:* — 管理用户配置的 MCP(Model Context Protocol)服务器。
 *
 * 所有通道都委托给单例 `mcpManager`,由它持有活跃连接,
 * 并将 `mcp:server-status-changed` / `mcp:server-list-changed`
 * 事件广播回渲染进程。
 *
 * `importJson` 通道接受 Claude Desktop / Cursor 的配置格式
 * `{ "mcpServers": { "<name>": { "command": ..., "args": [...],
 * "env": {...} } } }`,因此用户可直接粘贴现有配置而无需
 * 编辑。
 */

import { ipcMain } from "electron";

import { mcpManager } from "../mcp/manager";
import type { McpAuthType, McpServerInput, McpTransport } from "../mcp/types";

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

const pickString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const oauthConfig = (rec: JsonRecord) => asRecord(rec.oauth) ?? {};

const parseAuthType = (
  rec: JsonRecord,
  transport: McpTransport,
): McpAuthType => {
  if (transport !== "http") return "none";
  const raw = rec.authType ?? rec.auth;
  if (raw === "auto" || raw === "none" || raw === "oauth") return raw;
  return "auto";
};

const sanitizeInput = (raw: unknown): McpServerInput => {
  const rec = asRecord(raw) ?? {};
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) throw new Error("name is required");
  const transport =
    rec.transport === "http" ? ("http" as const) : ("stdio" as const);
  const trusted = rec.trusted === true;
  const enabled = rec.enabled !== false;
  const oauth = oauthConfig(rec);
  return {
    name,
    transport,
    command: typeof rec.command === "string" ? rec.command : null,
    args: asStringArray(rec.args),
    env: asStringRecord(rec.env),
    cwd: typeof rec.cwd === "string" ? rec.cwd : null,
    url: typeof rec.url === "string" ? rec.url : null,
    headers: asStringRecord(rec.headers),
    authType: parseAuthType(rec, transport),
    oauthScopes: asStringArray(rec.oauthScopes ?? rec.scopes),
    oauthClientId: pickString(
      rec.oauthClientId,
      oauth.client_id,
      oauth.clientId,
    ),
    oauthClientSecret: pickString(
      rec.oauthClientSecret,
      oauth.client_secret,
      oauth.clientSecret,
    ),
    enabled,
    trusted,
  };
};

/**
 * 将 Claude Desktop / Cursor / VS Code 的 `mcpServers` JSON 解析为我们的
 * `McpServerInput[]` 结构。通过启发式判断 transport:存在
 * `url` 则为 http,否则为 stdio。同时接受顶层
 * `{ mcpServers: {...} }` 封装和裸对象两种形式。
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
    const oauth = oauthConfig(entry);
    out.push({
      name,
      transport,
      command: typeof entry.command === "string" ? entry.command : null,
      args: asStringArray(entry.args),
      env: asStringRecord(entry.env),
      cwd: typeof entry.cwd === "string" ? entry.cwd : null,
      url: typeof entry.url === "string" ? entry.url : null,
      headers: asStringRecord(entry.headers),
      authType: parseAuthType(entry, transport),
      oauthScopes: asStringArray(entry.oauthScopes ?? entry.scopes),
      oauthClientId: pickString(
        entry.oauthClientId,
        oauth.client_id,
        oauth.clientId,
      ),
      oauthClientSecret: pickString(
        entry.oauthClientSecret,
        oauth.client_secret,
        oauth.clientSecret,
      ),
      enabled: entry.enabled !== false,
      trusted: entry.trusted === true,
    });
  }
  return out;
};

const toPublicMcpServer = <T extends { oauthClientSecret?: string | null }>(
  server: T,
): Omit<T, "oauthClientSecret"> & { oauthClientSecretConfigured: boolean } => {
  const { oauthClientSecret, ...rest } = server;
  return {
    ...rest,
    oauthClientSecretConfigured: Boolean(oauthClientSecret),
  };
};

export const registerMcpHandlers = (): void => {
  ipcMain.handle("mcp:listServers", async () =>
    mcpManager.listServersWithStatus().map(toPublicMcpServer),
  );

  ipcMain.handle("mcp:addServer", async (_event, payload: unknown) => {
    const input = sanitizeInput(payload);
    return toPublicMcpServer(await mcpManager.addServer(input));
  });

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
      if ("authType" in updates || "auth" in updates) {
        const transport =
          updates.transport === "stdio" || updates.transport === "http"
            ? updates.transport
            : "http";
        partial.authType = parseAuthType(updates, transport);
      }
      if ("oauthScopes" in updates || "scopes" in updates) {
        partial.oauthScopes = asStringArray(
          updates.oauthScopes ?? updates.scopes,
        );
      }
      if ("oauthClientId" in updates || "oauth" in updates) {
        const oauth = oauthConfig(updates);
        partial.oauthClientId = pickString(
          updates.oauthClientId,
          oauth.client_id,
          oauth.clientId,
        );
      }
      if ("oauthClientSecret" in updates || "oauth" in updates) {
        const oauth = oauthConfig(updates);
        partial.oauthClientSecret = pickString(
          updates.oauthClientSecret,
          oauth.client_secret,
          oauth.clientSecret,
        );
      }
      if ("enabled" in updates) partial.enabled = updates.enabled === true;
      if ("trusted" in updates) partial.trusted = updates.trusted === true;
      const updated = await mcpManager.updateServer(payload.id, partial);
      return updated ? toPublicMcpServer(updated) : null;
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

  ipcMain.handle("mcp:authorize", async (_event, payload: { id: string }) => {
    if (!payload?.id) throw new Error("id is required");
    return mcpManager.authorizeServer(payload.id);
  });

  ipcMain.handle(
    "mcp:clearAuthorization",
    async (_event, payload: { id: string }) => {
      if (!payload?.id) throw new Error("id is required");
      return mcpManager.clearAuthorization(payload.id);
    },
  );

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
