import { describe, expect, it } from "vitest";

import {
  classifyMcpAuthError,
  createMcpServerStatus,
  markMcpAuthError,
  markMcpAuthorizationCleared,
  markMcpAuthorized,
  markMcpAuthorizing,
  markMcpAuthRequired,
} from "../status";
import type { McpServer } from "../types";

const server = (
  overrides: Partial<Pick<McpServer, "transport" | "authType">> = {},
): Pick<McpServer, "id" | "transport" | "authType"> => ({
  id: "server-1",
  transport: "http",
  authType: "auto",
  ...overrides,
});

describe("MCP structured auth status", () => {
  it("marks stdio and static HTTP auth as not applicable", () => {
    expect(
      createMcpServerStatus(server({ transport: "stdio", authType: "none" })),
    ).toMatchObject({
      authStatus: "not_applicable",
      authMessage: null,
      authErrorCode: null,
      authUrl: null,
    });
    expect(
      createMcpServerStatus(server({ transport: "http", authType: "none" })),
    ).toMatchObject({
      authStatus: "not_applicable",
    });
  });

  it("marks HTTP OAuth as unknown until a token is present", () => {
    expect(createMcpServerStatus(server())).toMatchObject({
      authStatus: "unknown",
    });
    expect(
      createMcpServerStatus(server(), {
        tokens: { access_token: "access", token_type: "Bearer" },
      }),
    ).toMatchObject({
      authStatus: "authenticated",
    });
  });

  it("updates auth status through authorization transitions", () => {
    const status = createMcpServerStatus(server());

    markMcpAuthorizing(status);
    expect(status).toMatchObject({ authStatus: "authorizing" });

    markMcpAuthRequired(status, {
      message: "OAuth authorization required",
      authorizationUrl: "https://auth.example/authorize",
    });
    expect(status).toMatchObject({
      authStatus: "needs_auth",
      authMessage: "OAuth authorization required",
      authErrorCode: null,
      authUrl: "https://auth.example/authorize",
    });

    markMcpAuthError(status, "Timed out waiting for MCP OAuth callback", {
      code: "callback_timeout",
    });
    expect(status).toMatchObject({
      authStatus: "error",
      authMessage: "Timed out waiting for MCP OAuth callback",
      authErrorCode: "callback_timeout",
      authUrl: null,
    });

    markMcpAuthorized(status);
    expect(status).toMatchObject({
      authStatus: "authenticated",
      authMessage: null,
      authErrorCode: null,
      authUrl: null,
    });

    markMcpAuthorizationCleared(status);
    expect(status).toMatchObject({
      authStatus: "unknown",
      authMessage: null,
      authErrorCode: null,
      authUrl: null,
    });
  });

  it("classifies OAuth failures for observability", () => {
    expect(
      classifyMcpAuthError(
        new Error("Timed out waiting for MCP OAuth callback"),
        "callback",
      ),
    ).toBe("callback_timeout");
    expect(
      classifyMcpAuthError(
        new Error("OAuth callback state did not match"),
        "callback",
      ),
    ).toBe("state_mismatch");
    expect(
      classifyMcpAuthError(new Error("OAuth callback failed: access_denied")),
    ).toBe("callback_error");
    expect(
      classifyMcpAuthError(new Error("invalid_grant"), "token_exchange"),
    ).toBe("token_exchange_failed");
    expect(
      classifyMcpAuthError(new Error("transport closed"), "connection"),
    ).toBe("connection_failed");
  });
});
