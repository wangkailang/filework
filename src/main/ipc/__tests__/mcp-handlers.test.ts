import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, payload: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
}));

const managerCalls = {
  added: [] as unknown[],
  listed: [] as unknown[],
  authorized: [] as string[],
  cleared: [] as string[],
};

vi.mock("../../mcp/manager", () => ({
  mcpManager: {
    addServer: vi.fn(async (input: unknown) => {
      managerCalls.added.push(input);
      return { id: `server-${managerCalls.added.length}`, input };
    }),
    authorizeServer: vi.fn(async (id: string) => {
      managerCalls.authorized.push(id);
      return { ok: true };
    }),
    clearAuthorization: vi.fn(async (id: string) => {
      managerCalls.cleared.push(id);
      return { ok: true };
    }),
    deleteServer: vi.fn(),
    listServersWithStatus: vi.fn(() => managerCalls.listed),
    listTools: vi.fn(() => []),
    reconnect: vi.fn(),
    setEnabled: vi.fn(),
    setTrusted: vi.fn(),
    testConnection: vi.fn(async () => ({ ok: true, toolCount: 0 })),
    updateServer: vi.fn(async (_id: string, updates: unknown) => ({
      id: _id,
      ...(updates as Record<string, unknown>),
    })),
  },
}));

import { registerMcpHandlers } from "../mcp-handlers";

describe("mcp handlers", () => {
  beforeEach(() => {
    handlers.clear();
    managerCalls.added = [];
    managerCalls.listed = [];
    managerCalls.authorized = [];
    managerCalls.cleared = [];
    registerMcpHandlers();
  });

  it("imports OAuth HTTP servers from Hermes-style JSON", async () => {
    const importJson = handlers.get("mcp:importJson");
    if (!importJson) throw new Error("mcp:importJson not registered");

    const result = await importJson(null, {
      json: JSON.stringify({
        mcpServers: {
          linear: {
            url: "https://mcp.linear.app/mcp",
            auth: "oauth",
            scopes: ["read:issues", "write:comments"],
            oauth: {
              client_id: "client-123",
              client_secret: "secret-456",
            },
          },
        },
      }),
    });

    expect(result).toEqual({ added: 1, errors: [] });
    expect(managerCalls.added[0]).toMatchObject({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      authType: "oauth",
      oauthScopes: ["read:issues", "write:comments"],
      oauthClientId: "client-123",
      oauthClientSecret: "secret-456",
    });
  });

  it("defaults imported HTTP servers to automatic auth discovery", async () => {
    const importJson = handlers.get("mcp:importJson");
    if (!importJson) throw new Error("mcp:importJson not registered");

    const result = await importJson(null, {
      json: JSON.stringify({
        mcpServers: {
          linear: {
            url: "https://mcp.linear.app/mcp",
          },
        },
      }),
    });

    expect(result).toEqual({ added: 1, errors: [] });
    expect(managerCalls.added[0]).toMatchObject({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      authType: "auto",
    });
  });

  it("strips OAuth client secrets before returning MCP servers to the renderer", async () => {
    managerCalls.listed = [
      {
        id: "server-1",
        name: "gmail",
        transport: "http",
        url: "https://gmail.example/mcp",
        authType: "oauth",
        oauthClientId: "client-123",
        oauthClientSecret: "secret-456",
        status: { connected: false },
      },
    ];

    const list = handlers.get("mcp:listServers");
    const servers = await list?.(null, undefined);

    expect(JSON.stringify(servers)).not.toContain("secret-456");
    expect(servers).toEqual([
      expect.objectContaining({
        authType: "oauth",
        oauthClientSecretConfigured: true,
      }),
    ]);
  });

  it("exposes an explicit OAuth authorize action", async () => {
    const authorize = handlers.get("mcp:authorize");
    if (!authorize) throw new Error("mcp:authorize not registered");

    const result = await authorize(null, { id: "server-1" });

    expect(result).toEqual({ ok: true });
    expect(managerCalls.authorized).toEqual(["server-1"]);
  });

  it("exposes an explicit OAuth clear authorization action", async () => {
    const clear = handlers.get("mcp:clearAuthorization");
    if (!clear) throw new Error("mcp:clearAuthorization not registered");

    const result = await clear(null, { id: "server-1" });

    expect(result).toEqual({ ok: true });
    expect(managerCalls.cleared).toEqual(["server-1"]);
  });
});
