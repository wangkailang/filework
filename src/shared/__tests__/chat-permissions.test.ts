import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_PERMISSION_MODE,
  resolveChatPermissionMode,
  resolveChatPermissionRunConfig,
} from "../chat-permissions";

describe("chat permission modes", () => {
  it("falls back to the default mode for unknown persisted values", () => {
    expect(resolveChatPermissionMode("bogus")).toBe(
      DEFAULT_CHAT_PERMISSION_MODE,
    );
    expect(resolveChatPermissionMode(null)).toBe(DEFAULT_CHAT_PERMISSION_MODE);
  });

  it("maps chat permission modes to sandbox and approval policies", () => {
    expect(resolveChatPermissionRunConfig("request")).toEqual({
      approvalPolicy: "on-request",
      autoApprovePlans: false,
      sandboxMode: "workspace-write",
    });
    expect(resolveChatPermissionRunConfig("auto")).toEqual({
      approvalPolicy: "never",
      autoApprovePlans: true,
      sandboxMode: "workspace-write",
    });
    expect(resolveChatPermissionRunConfig("full")).toEqual({
      approvalPolicy: "never",
      autoApprovePlans: true,
      sandboxMode: "danger-full-access",
    });
  });
});
