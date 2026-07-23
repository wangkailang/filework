import { describe, expect, it } from "vitest";
import {
  BROWSER_SETTING_STORAGE_KEYS,
  type BrowserSettings,
  DEFAULT_BROWSER_SETTINGS,
  decodeBrowserSettings,
  encodeBrowserSetting,
  isBrowserActionRequest,
  parseBrowserSettingsPatch,
  parseBrowserUrl,
} from "../browser";

describe("shared browser contracts", () => {
  it("accepts only credential-free HTTP(S) URLs", () => {
    expect(parseBrowserUrl("https://example.com").protocol).toBe("https:");
    expect(parseBrowserUrl("http://localhost:5173").protocol).toBe("http:");

    expect(() => parseBrowserUrl("file:///etc/passwd")).toThrow(/scheme/i);
    expect(() => parseBrowserUrl("javascript:alert(1)")).toThrow(/scheme/i);
    expect(() => parseBrowserUrl("https://user:pass@example.com")).toThrow(
      /credentials/i,
    );
    expect(() => parseBrowserUrl("not a URL")).toThrow(/invalid/i);
  });

  it("recognizes browser action requests with snapshot guards", () => {
    expect(
      isBrowserActionRequest({
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        action: { type: "click", ref: "e12" },
      }),
    ).toBe(true);

    expect(
      isBrowserActionRequest({
        tabId: "tab-1",
        navigationId: "nav-1",
        action: { type: "click", ref: "e12" },
      }),
    ).toBe(false);
    expect(
      isBrowserActionRequest({
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        action: { type: "click", ref: "" },
      }),
    ).toBe(false);
  });
});

describe("browser settings contract", () => {
  it("uses safe defaults when no browser settings are persisted", () => {
    expect(DEFAULT_BROWSER_SETTINGS).toEqual({
      sharedSurfaceEnabled: false,
      allowedOrigins: [],
      blockedOrigins: [],
      developerModeEnabled: false,
      downloadAskEveryTime: true,
      downloadDirectory: "",
    });
    expect(decodeBrowserSettings(() => null)).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it("round-trips each whitelisted browser setting", () => {
    const values: BrowserSettings = {
      sharedSurfaceEnabled: true,
      allowedOrigins: ["https://example.com"],
      blockedOrigins: ["https://blocked.example"],
      developerModeEnabled: true,
      downloadAskEveryTime: false,
      downloadDirectory: "/tmp/downloads",
    };
    const persisted = new Map<string, string>();

    for (const key of Object.keys(BROWSER_SETTING_STORAGE_KEYS) as Array<
      keyof typeof BROWSER_SETTING_STORAGE_KEYS
    >) {
      persisted.set(
        BROWSER_SETTING_STORAGE_KEYS[key],
        encodeBrowserSetting(key, values[key]),
      );
    }

    expect(decodeBrowserSettings((key) => persisted.get(key) ?? null)).toEqual(
      values,
    );
  });

  it("rejects unknown keys and invalid values in renderer patches", () => {
    expect(
      parseBrowserSettingsPatch({
        sharedSurfaceEnabled: true,
        allowedOrigins: ["https://example.com"],
      }),
    ).toEqual({
      sharedSurfaceEnabled: true,
      allowedOrigins: ["https://example.com"],
    });

    expect(() => parseBrowserSettingsPatch({ arbitrarySetting: true })).toThrow(
      /setting/i,
    );
    expect(() =>
      parseBrowserSettingsPatch({ allowedOrigins: ["not-an-origin"] }),
    ).toThrow(/origin/i);
  });
});
