import { describe, expect, it } from "vitest";

import { shouldShowClearAuthorization } from "../McpConfigPanel";

type AuthStatus =
  | "not_applicable"
  | "unknown"
  | "needs_auth"
  | "authorizing"
  | "authenticated"
  | "expired"
  | "error";

const row = (authStatus: AuthStatus) => ({
  authType: "auto" as const,
  status: {
    authStatus,
  },
});

describe("McpConfigPanel auth actions", () => {
  it("does not show clear authorization before a server is authorized", () => {
    expect(shouldShowClearAuthorization(row("unknown"))).toBe(false);
    expect(shouldShowClearAuthorization(row("needs_auth"))).toBe(false);
    expect(shouldShowClearAuthorization(row("authorizing"))).toBe(false);
  });

  it("shows clear authorization only after OAuth is authenticated", () => {
    expect(shouldShowClearAuthorization(row("authenticated"))).toBe(true);
  });
});
