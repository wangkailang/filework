import { describe, expect, it } from "vitest";

import {
  buildMcpOAuthRedirectUrl,
  resolveMcpOAuthSettings,
} from "../auth-settings";

describe("MCP OAuth settings", () => {
  it("defaults to keychain-backed storage when secure storage is available", () => {
    const settings = resolveMcpOAuthSettings(
      {},
      { safeStorageAvailable: true },
    );

    expect(settings.credentialsStore).toBe("auto");
    expect(settings.effectiveCredentialsStore).toBe("keychain");
  });

  it("falls back to database storage when keychain encryption is unavailable", () => {
    const settings = resolveMcpOAuthSettings(
      { credentialsStore: "keychain" },
      { safeStorageAvailable: false },
    );

    expect(settings.credentialsStore).toBe("keychain");
    expect(settings.effectiveCredentialsStore).toBe("database");
  });

  it("normalizes callback host, port, and path", () => {
    const settings = resolveMcpOAuthSettings(
      {
        callbackHost: "0.0.0.0",
        callbackPort: "54321",
        callbackPath: "mcp/callback",
      },
      { safeStorageAvailable: true },
    );

    expect(settings.callbackHost).toBe("127.0.0.1");
    expect(settings.callbackPort).toBe(54321);
    expect(settings.callbackPath).toBe("/mcp/callback");
    expect(buildMcpOAuthRedirectUrl(settings, 54321)).toBe(
      "http://127.0.0.1:54321/mcp/callback",
    );
  });
});
