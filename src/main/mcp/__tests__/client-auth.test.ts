import { describe, expect, it } from "vitest";

import { shouldUseMcpOAuthProvider } from "../client";
import type { McpServer } from "../types";

const server = (
  overrides: Partial<Pick<McpServer, "transport" | "authType">>,
): Pick<McpServer, "transport" | "authType"> => ({
  transport: "http",
  authType: "auto",
  ...overrides,
});

describe("shouldUseMcpOAuthProvider", () => {
  it("enables the OAuth provider for automatic and explicit HTTP auth", () => {
    expect(shouldUseMcpOAuthProvider(server({ authType: "auto" }))).toBe(true);
    expect(shouldUseMcpOAuthProvider(server({ authType: "oauth" }))).toBe(true);
  });

  it("does not enable the OAuth provider for static or stdio auth", () => {
    expect(shouldUseMcpOAuthProvider(server({ authType: "none" }))).toBe(false);
    expect(
      shouldUseMcpOAuthProvider(
        server({ transport: "stdio", authType: "oauth" }),
      ),
    ).toBe(false);
  });
});
