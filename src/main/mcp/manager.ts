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

import { createServer, type Server } from "node:http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool as McpToolDescriptor } from "@modelcontextprotocol/sdk/types.js";
import { BrowserWindow, shell } from "electron";

import type { ToolDefinition } from "../core/agent/tool-registry";
import {
  createMcpServer,
  deleteMcpOAuthSession,
  deleteMcpServer,
  getMcpOAuthSession,
  getMcpServer,
  getSetting,
  listMcpServers,
  type McpServer,
  type McpServerInput,
  saveMcpOAuthSession,
  updateMcpServer,
} from "../db";
import { isKeychainEncryptionAvailable } from "../db/crypto";
import {
  buildMcpOAuthRedirectUrl,
  resolveMcpOAuthSettings,
} from "./auth-settings";
import {
  McpAuthorizationRequiredError,
  McpClient,
  shouldUseMcpOAuthProvider,
} from "./client";
import { createMcpOAuthProvider } from "./oauth-provider";
import {
  classifyMcpAuthError,
  createMcpServerStatus,
  type McpAuthFailureStage,
  markMcpAuthError,
  markMcpAuthorizationCleared,
  markMcpAuthorized,
  markMcpAuthorizing,
  markMcpAuthRequired,
} from "./status";
import { buildMcpToolDefs } from "./tool-bridge";
import type { McpOAuthSession, McpServerStatus, McpToolSummary } from "./types";

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

  async authorizeServer(id: string): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: "MCP server not found" };
    if (!shouldUseMcpOAuthProvider(entry.config)) {
      return { ok: false, error: "MCP server is not configured for OAuth" };
    }
    if (!entry.config.url) {
      return { ok: false, error: "MCP HTTP server requires url" };
    }

    entry.status.connecting = true;
    entry.status.lastError = null;
    markMcpAuthorizing(entry.status);
    this.notifyStatus(id);

    let callback: OAuthCallback | null = null;
    let authStage: McpAuthFailureStage = "callback_listener";
    try {
      callback = await startOAuthCallbackServer(
        entry.config.name,
        getMcpOAuthSettings(),
      );
      authStage = "authorization";
      const store = buildOAuthSessionStore(entry.config.id);
      const current = store.get();
      store.set({
        ...current,
        tokens: undefined,
        ...(entry.config.oauthClientId ? {} : { clientInformation: undefined }),
      });
      const provider = createMcpOAuthProvider({
        serverId: entry.config.id,
        serverName: entry.config.name,
        serverUrl: entry.config.url,
        redirectUrl: callback.redirectUrl,
        scopes: entry.config.oauthScopes,
        oauthClientId: entry.config.oauthClientId,
        oauthClientSecret: entry.config.oauthClientSecret,
        sessionStore: store,
        interactive: true,
        openExternal: (url) => shell.openExternal(url),
      });

      const result = await auth(provider, { serverUrl: entry.config.url });
      if (result !== "REDIRECT") {
        entry.status.connecting = false;
        await this.reconnect(id);
        return { ok: true };
      }

      authStage = "callback";
      const { code, state } = await callback.waitForCode();
      const expectedState = store.get().authorizationState;
      if (expectedState && state !== expectedState) {
        throw new Error("OAuth callback state did not match");
      }
      authStage = "token_exchange";
      await auth(provider, {
        serverUrl: entry.config.url,
        authorizationCode: code,
      });
      entry.status.connecting = false;
      markMcpAuthorized(entry.status);
      await this.reconnect(id);
      this.notifyStatus(id);
      return { ok: true };
    } catch (err) {
      entry.status.connected = false;
      entry.status.connecting = false;
      entry.status.lastError = err instanceof Error ? err.message : String(err);
      markMcpAuthError(entry.status, entry.status.lastError, {
        code: classifyMcpAuthError(err, authStage),
      });
      this.notifyStatus(id);
      return { ok: false, error: entry.status.lastError };
    } finally {
      callback?.close();
    }
  }

  async clearAuthorization(id: string): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: "MCP server not found" };
    if (!shouldUseMcpOAuthProvider(entry.config)) {
      return { ok: false, error: "MCP server is not configured for OAuth" };
    }

    await entry.client.disconnect();
    deleteMcpOAuthSession(id);
    entry.status.connected = false;
    entry.status.connecting = false;
    entry.status.toolCount = 0;
    entry.status.lastError = null;
    markMcpAuthorizationCleared(entry.status);
    this.notifyStatus(id);

    if (entry.config.enabled) void this.connectEntry(entry);
    return { ok: true };
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
      authType:
        input.transport === "http" ? (input.authType ?? "auto") : "none",
      oauthScopes: input.oauthScopes ?? [],
      oauthClientId: input.oauthClientId ?? null,
      oauthClientSecret: input.oauthClientSecret ?? null,
      enabled: true,
      trusted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const client = new McpClient(fake, {
      oauthSessionStore: buildTransientOAuthSessionStore(),
      openExternal: (url) => shell.openExternal(url),
    });
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
    const status = createMcpServerStatus(config, getMcpOAuthSession(config.id));
    const client = new McpClient(config, {
      oauthSessionStore: buildOAuthSessionStore(config.id),
      openExternal: (url) => shell.openExternal(url),
      oauthRedirectUrl: getSilentOAuthRedirectUrl(),
      onToolsChanged: (tools) => {
        status.toolCount = tools.length;
        this.notifyStatus(config.id);
      },
      onTransportClose: (err) => {
        status.connected = false;
        status.connecting = false;
        status.toolCount = 0;
        status.lastError = err ? err.message : null;
        if (err && shouldUseMcpOAuthProvider(config)) {
          markMcpAuthError(status, err.message, { stage: "connection" });
        }
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
      if (shouldUseMcpOAuthProvider(entry.config)) {
        markMcpAuthorized(entry.status);
      }
    } catch (err) {
      entry.status.connected = false;
      entry.status.connecting = false;
      entry.status.toolCount = 0;
      entry.status.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof McpAuthorizationRequiredError) {
        markMcpAuthRequired(entry.status, {
          message: err.message,
          authorizationUrl: getMcpOAuthSession(entry.config.id)
            .authorizationUrl,
        });
      } else if (shouldUseMcpOAuthProvider(entry.config)) {
        markMcpAuthError(entry.status, entry.status.lastError, {
          stage: "connection",
        });
      }
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

interface OAuthCallback {
  redirectUrl: string;
  waitForCode(): Promise<{ code: string; state: string | null }>;
  close(): void;
}

const startOAuthCallbackServer = async (
  serverName: string,
  settings: ReturnType<typeof getMcpOAuthSettings>,
): Promise<OAuthCallback> => {
  let server: Server | null = null;
  let settled = false;
  let resolveCode!: (value: { code: string; state: string | null }) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<{ code: string; state: string | null }>(
    (resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    },
  );

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== settings.callbackPath) {
      res.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {
      const error = url.searchParams.get("error") ?? "missing_code";
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`OAuth failed: ${error}`);
      if (!settled) {
        settled = true;
        rejectCode(new Error(`OAuth callback failed: ${error}`));
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<title>Filework MCP OAuth</title><p>${escapeHtml(serverName)} is authorized. You can return to Filework.</p>`,
    );
    if (!settled) {
      settled = true;
      resolveCode({ code, state });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(settings.callbackPort, settings.callbackHost, () =>
      resolve(),
    );
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to open MCP OAuth callback listener");
  }

  const timeout = setTimeout(
    () => {
      if (!settled) {
        settled = true;
        rejectCode(new Error("Timed out waiting for MCP OAuth callback"));
      }
    },
    5 * 60 * 1000,
  );

  return {
    redirectUrl: buildMcpOAuthRedirectUrl(settings, address.port),
    waitForCode: () => codePromise,
    close: () => {
      clearTimeout(timeout);
      server?.close();
    },
  };
};

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const buildOAuthSessionStore = (serverId: string) => ({
  get: () => getMcpOAuthSession(serverId),
  set: (session: McpOAuthSession) =>
    saveMcpOAuthSession(serverId, session, {
      credentialsStore: getMcpOAuthSettings().effectiveCredentialsStore,
    }),
});

const buildTransientOAuthSessionStore = () => {
  let session: McpOAuthSession = {};
  return {
    get: () => session,
    set: (next: McpOAuthSession) => {
      session = next;
    },
  };
};

const getMcpOAuthSettings = () =>
  resolveMcpOAuthSettings(
    {
      credentialsStore: getSetting("mcp.oauth.credentialsStore"),
      callbackHost: getSetting("mcp.oauth.callbackHost"),
      callbackPort: getSetting("mcp.oauth.callbackPort"),
      callbackPath: getSetting("mcp.oauth.callbackPath"),
    },
    { safeStorageAvailable: isKeychainEncryptionAvailable() },
  );

const getSilentOAuthRedirectUrl = () => {
  const settings = getMcpOAuthSettings();
  return buildMcpOAuthRedirectUrl(settings);
};

export const mcpManager = new McpManager();
export { slug as slugForMcpServerName };
export type McpToolDescriptorT = McpToolDescriptor;
