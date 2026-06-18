import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { McpAuthorizationRequiredError, McpClient } from "../client";
import { createMcpOAuthProvider } from "../oauth-provider";
import type { McpOAuthSession, McpServer } from "../types";

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const raw = await readTextBody(req);
  return raw ? JSON.parse(raw) : undefined;
};

const readTextBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
};

const sendJson = (
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
};

const startOAuthMcpServer = async () => {
  const issuedCodes = new Set<string>();
  const validAccessToken = `access-${randomUUID()}`;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let baseUrl = "";
  let mcpUrl = "";
  let resourceMetadataUrl = "";

  const sdkServerFactory = () => {
    const server = new SdkMcpServer({
      name: "oauth-integration",
      version: "1",
    });
    server.tool("ping", "Ping tool", async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseUrl);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      sendJson(res, 200, {
        resource: mcpUrl,
        authorization_servers: [baseUrl],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      if (!redirectUri || !codeChallenge) {
        res.writeHead(400).end("missing redirect_uri or PKCE challenge");
        return;
      }
      const code = `code-${randomUUID()}`;
      issuedCodes.add(code);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      if (state) callback.searchParams.set("state", state);
      res.writeHead(302, { Location: callback.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const raw = await readTextBody(req);
      const body = new URLSearchParams(raw);
      const code = body.get("code");
      if (
        body.get("grant_type") !== "authorization_code" ||
        !code ||
        !issuedCodes.has(code) ||
        !body.get("code_verifier")
      ) {
        sendJson(res, 400, { error: "invalid_grant" });
        return;
      }
      issuedCodes.delete(code);
      sendJson(res, 200, {
        access_token: validAccessToken,
        refresh_token: `refresh-${randomUUID()}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${validAccessToken}`) {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
        });
        res.end("authorization required");
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string" && transports.has(sessionId)) {
        await transports.get(sessionId)?.handleRequest(req, res);
        return;
      }

      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) transports.delete(id);
      };
      await sdkServerFactory().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind to a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  mcpUrl = `${baseUrl}/mcp`;
  resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
  return { server, mcpUrl, baseUrl };
};

const makeStore = () => {
  let session: McpOAuthSession = {};
  return {
    get: () => session,
    set: (next: McpOAuthSession) => {
      session = next;
    },
  };
};

const serverConfig = (url: string): McpServer => ({
  id: "server-1",
  name: "oauth-local",
  transport: "http",
  command: null,
  args: [],
  env: {},
  cwd: null,
  url,
  headers: {},
  authType: "auto",
  oauthScopes: ["mcp:tools"],
  oauthClientId: "integration-client",
  oauthClientSecret: null,
  enabled: true,
  trusted: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("MCP OAuth integration", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  it("uses the configured callback URL through a real OAuth code flow before connecting", async () => {
    const started = await startOAuthMcpServer();
    server = started.server;
    const store = makeStore();
    const redirectUrl = "http://127.0.0.1:54321/mcp/callback";
    const config = serverConfig(started.mcpUrl);
    const client = new McpClient(config, {
      oauthSessionStore: store,
      oauthRedirectUrl: redirectUrl,
    });

    await expect(client.connect()).rejects.toBeInstanceOf(
      McpAuthorizationRequiredError,
    );
    const authorizationUrl = store.get().authorizationUrl;
    expect(authorizationUrl).toBeTruthy();
    expect(
      new URL(authorizationUrl ?? "").searchParams.get("redirect_uri"),
    ).toBe(redirectUrl);

    const authorizationResponse = await fetch(authorizationUrl ?? "", {
      redirect: "manual",
    });
    const callbackUrl = authorizationResponse.headers.get("location");
    const code = callbackUrl
      ? new URL(callbackUrl).searchParams.get("code")
      : null;
    expect(code).toBeTruthy();

    const provider = createMcpOAuthProvider({
      serverId: config.id,
      serverName: config.name,
      serverUrl: started.mcpUrl,
      redirectUrl,
      scopes: config.oauthScopes,
      oauthClientId: config.oauthClientId,
      oauthClientSecret: config.oauthClientSecret,
      sessionStore: store,
      interactive: false,
      openExternal: () => undefined,
    });
    await auth(provider, {
      serverUrl: started.mcpUrl,
      authorizationCode: code ?? "",
    });

    await client.connect();
    expect(client.getTools().map((tool) => tool.name)).toContain("ping");
    await client.disconnect();
  });
});
