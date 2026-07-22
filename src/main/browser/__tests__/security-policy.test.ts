import { describe, expect, it, vi } from "vitest";
import {
  assertAgentBrowserUrl,
  createControlledWindowOpenHandler,
  denyBrowserPermissionCheck,
  denyBrowserPermissionRequest,
  hardenGuestWebPreferences,
  validateGuestAttachment,
} from "../security-policy";

describe("agent browser URL policy", () => {
  it.each([
    "file:///etc/passwd",
    "data:text/html,<h1>unsafe</h1>",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "not a URL",
  ])("rejects %s", (raw) => {
    expect(() => assertAgentBrowserUrl(raw)).toThrow();
  });

  it("allows credential-free HTTP(S), including localhost", () => {
    expect(assertAgentBrowserUrl("https://example.com/path").href).toBe(
      "https://example.com/path",
    );
    expect(assertAgentBrowserUrl("http://localhost:5173").hostname).toBe(
      "localhost",
    );
  });
});

describe("Electron guest hardening", () => {
  it("removes injected preloads and forces the secure preference baseline", () => {
    const preferences: Record<string, unknown> = {
      preload: "/tmp/evil.js",
      preloadURL: "file:///tmp/evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
    };

    hardenGuestWebPreferences(preferences);

    expect(preferences).not.toHaveProperty("preload");
    expect(preferences).not.toHaveProperty("preloadURL");
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
  });

  it("allows only known partition and URL combinations", () => {
    expect(() =>
      validateGuestAttachment({
        partition: "persist:in-app-browser",
        src: "https://example.com",
      }),
    ).not.toThrow();
    expect(() =>
      validateGuestAttachment({
        partition: "artifact-preview",
        src: "local-file://open?path=%2Ftmp%2Fpreview.html",
      }),
    ).not.toThrow();
    expect(() =>
      validateGuestAttachment({
        partition: "persist:in-app-browser",
        src: "file:///etc/passwd",
      }),
    ).toThrow(/URL|scheme/i);
    expect(() =>
      validateGuestAttachment({
        partition: "persist:unknown",
        src: "https://example.com",
      }),
    ).toThrow(/partition/i);
  });

  it("denies web permissions by default", () => {
    expect(denyBrowserPermissionCheck()).toBe(false);
    const callback = vi.fn();
    denyBrowserPermissionRequest({}, "geolocation", callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it("always denies Chromium popup creation and delegates only valid web URLs", () => {
    const onAllowedUrl = vi.fn();
    const handler = createControlledWindowOpenHandler(onAllowedUrl);

    expect(handler({ url: "https://example.com/new" })).toEqual({
      action: "deny",
    });
    expect(onAllowedUrl).toHaveBeenCalledWith("https://example.com/new");

    expect(handler({ url: "javascript:alert(1)" })).toEqual({
      action: "deny",
    });
    expect(onAllowedUrl).toHaveBeenCalledTimes(1);
  });
});
