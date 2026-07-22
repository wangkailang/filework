import { describe, expect, it, vi } from "vitest";

const profileMocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fakeSession = {
    listeners,
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setProxy: vi.fn(async () => undefined),
    setSpellCheckerEnabled: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    clearData: vi.fn(async () => undefined),
    clearAuthCache: vi.fn(async () => undefined),
    clearCodeCaches: vi.fn(async () => undefined),
    clearHostResolverCache: vi.fn(async () => undefined),
  };
  return {
    fakeSession,
    fromPartition: vi.fn(() => fakeSession),
  };
});

vi.mock("electron", () => ({
  session: { fromPartition: profileMocks.fromPartition },
}));

import {
  clearBrowserProfileData,
  initializeBrowserProfile,
  redactBrowserUrlForLog,
} from "../browser-profile";

describe("browser profile", () => {
  it("initializes each partition once with deny-by-default permissions", async () => {
    const partition = "persist:test-browser-profile";
    const first = initializeBrowserProfile(partition);
    const second = initializeBrowserProfile(partition);
    await Promise.all([first, second]);

    expect(profileMocks.fromPartition).toHaveBeenCalledTimes(1);
    expect(profileMocks.fakeSession.setProxy).toHaveBeenCalledWith({
      mode: "system",
    });
    expect(
      profileMocks.fakeSession.setSpellCheckerEnabled,
    ).toHaveBeenCalledWith(true);

    const check = profileMocks.fakeSession.setPermissionCheckHandler.mock
      .calls[0][0] as () => boolean;
    expect(check()).toBe(false);
    const request = profileMocks.fakeSession.setPermissionRequestHandler.mock
      .calls[0][0] as (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    const callback = vi.fn();
    request({}, "geolocation", callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it("cancels downloads until a controlled download handler is supplied", async () => {
    await initializeBrowserProfile("persist:test-download-profile");
    const listener = profileMocks.fakeSession.listeners.get("will-download");
    const event = { preventDefault: vi.fn() };
    const item = { cancel: vi.fn() };

    listener?.(event, item, {});

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(item.cancel).toHaveBeenCalledOnce();
  });

  it("clears persisted browser data and redacts sensitive URL parts", async () => {
    await clearBrowserProfileData("persist:test-clear-profile");

    expect(profileMocks.fakeSession.clearData).toHaveBeenCalled();
    expect(profileMocks.fakeSession.clearAuthCache).toHaveBeenCalled();
    expect(profileMocks.fakeSession.clearCodeCaches).toHaveBeenCalledWith({
      urls: [],
    });
    expect(profileMocks.fakeSession.clearHostResolverCache).toHaveBeenCalled();
    expect(
      redactBrowserUrlForLog("https://example.com/path?q=secret#token"),
    ).toBe("https://example.com/path");
    expect(redactBrowserUrlForLog("not a URL")).toBe("[invalid-url]");
  });
});
