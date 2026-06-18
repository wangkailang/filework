import { describe, expect, it, vi } from "vitest";

import { createMcpOAuthProvider } from "../oauth-provider";
import type { McpOAuthSession } from "../types";

const makeStore = (initial: McpOAuthSession = {}) => {
  let session = initial;
  return {
    get: vi.fn(() => session),
    set: vi.fn((next: McpOAuthSession) => {
      session = next;
    }),
  };
};

describe("createMcpOAuthProvider", () => {
  it("uses pre-registered client credentials when configured", async () => {
    const store = makeStore();
    const provider = createMcpOAuthProvider({
      serverId: "server-1",
      serverName: "Gmail",
      serverUrl: "https://gmail.example/mcp",
      redirectUrl: "http://127.0.0.1:49152/callback",
      scopes: ["gmail.readonly"],
      oauthClientId: "client-123",
      oauthClientSecret: "secret-456",
      sessionStore: store,
      interactive: false,
      openExternal: vi.fn(),
    });

    expect(provider.clientMetadata).toMatchObject({
      client_name: "Filework Desktop - Gmail",
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      scope: "gmail.readonly",
    });
    await expect(provider.clientInformation()).resolves.toMatchObject({
      client_id: "client-123",
      client_secret: "secret-456",
    });
  });

  it("round-trips OAuth tokens and dynamic client information through the session store", async () => {
    const store = makeStore();
    const provider = createMcpOAuthProvider({
      serverId: "server-1",
      serverName: "Linear",
      serverUrl: "https://mcp.linear.app/mcp",
      redirectUrl: "http://127.0.0.1:49152/callback",
      scopes: [],
      sessionStore: store,
      interactive: false,
      openExternal: vi.fn(),
    });

    await provider.saveClientInformation?.({
      client_id: "dynamic-client",
      client_secret: "dynamic-secret",
    });
    await provider.saveTokens({
      access_token: "access-token",
      token_type: "Bearer",
      refresh_token: "refresh-token",
    });

    await expect(provider.clientInformation()).resolves.toMatchObject({
      client_id: "dynamic-client",
    });
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });

  it("opens the authorization URL only for interactive login", async () => {
    const openExternal = vi.fn();
    const silent = createMcpOAuthProvider({
      serverId: "server-1",
      serverName: "Linear",
      serverUrl: "https://mcp.linear.app/mcp",
      redirectUrl: "http://127.0.0.1:49152/callback",
      scopes: [],
      sessionStore: makeStore(),
      interactive: false,
      openExternal,
    });
    await silent.redirectToAuthorization(
      new URL("https://auth.example/silent"),
    );

    const interactive = createMcpOAuthProvider({
      serverId: "server-1",
      serverName: "Linear",
      serverUrl: "https://mcp.linear.app/mcp",
      redirectUrl: "http://127.0.0.1:49152/callback",
      scopes: [],
      sessionStore: makeStore(),
      interactive: true,
      openExternal,
    });
    await interactive.redirectToAuthorization(
      new URL("https://auth.example/interactive"),
    );

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      "https://auth.example/interactive",
    );
  });
});
