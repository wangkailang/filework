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
  createControlledBrowserDownloadHandler,
  initializeBrowserProfile,
  redactBrowserUrlForLog,
  resolveAvailableDownloadPath,
  sanitizeBrowserDownloadFilename,
  setBrowserProfileDownloadHandler,
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

    expect(profileMocks.fakeSession.clearData).toHaveBeenCalledWith({
      dataTypes: expect.arrayContaining([
        "cache",
        "cookies",
        "downloads",
        "localStorage",
        "serviceWorkers",
      ]),
    });
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

  it("sanitizes suggested names and avoids silently overwriting files", () => {
    expect(sanitizeBrowserDownloadFilename("../../private/report?.pdf")).toBe(
      "report_.pdf",
    );
    expect(sanitizeBrowserDownloadFilename("..")).toBe("download");

    const occupied = new Set([
      "/Downloads/report.pdf",
      "/Downloads/report (1).pdf",
    ]);
    expect(
      resolveAvailableDownloadPath("/Downloads/report.pdf", (candidate) =>
        occupied.has(candidate),
      ),
    ).toBe("/Downloads/report (2).pdf");
  });

  it("uses a unique configured path and reports download progress", async () => {
    const partition = "persist:test-controlled-download";
    const states = vi.fn();
    const handler = createControlledBrowserDownloadHandler({
      createId: () => "download-1",
      getDefaultDirectory: () => "/Downloads",
      getPreferences: () => ({
        askEveryTime: false,
        directory: "/Downloads",
      }),
      onState: states,
      pathExists: (candidate) => candidate === "/Downloads/report.pdf",
    });
    setBrowserProfileDownloadHandler(partition, handler);
    await initializeBrowserProfile(partition);

    const listeners = new Map<string, (...args: unknown[]) => void>();
    let receivedBytes = 0;
    const item = {
      cancel: vi.fn(),
      getFilename: vi.fn(() => "../report.pdf"),
      getReceivedBytes: vi.fn(() => receivedBytes),
      getSavePath: vi.fn(() => "/Downloads/report (1).pdf"),
      getTotalBytes: vi.fn(() => 100),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      setSaveDialogOptions: vi.fn(),
      setSavePath: vi.fn(),
    };
    const event = { preventDefault: vi.fn() };

    profileMocks.fakeSession.listeners.get("will-download")?.(event, item, {});

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledWith("/Downloads/report (1).pdf");
    expect(states).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "download-1",
        filename: "report.pdf",
        savePath: "/Downloads/report (1).pdf",
        status: "progressing",
      }),
    );

    receivedBytes = 60;
    listeners.get("updated")?.({}, "progressing");
    expect(states).toHaveBeenLastCalledWith(
      expect.objectContaining({ receivedBytes: 60, status: "progressing" }),
    );

    receivedBytes = 100;
    listeners.get("done")?.({}, "completed");
    expect(states).toHaveBeenLastCalledWith(
      expect.objectContaining({ receivedBytes: 100, status: "completed" }),
    );
  });

  it("uses Electron's native save dialog when downloads ask every time", () => {
    const handler = createControlledBrowserDownloadHandler({
      getDefaultDirectory: () => "/Downloads",
      getPreferences: () => ({ askEveryTime: true, directory: "" }),
      onState: vi.fn(),
    });
    const item = {
      cancel: vi.fn(),
      getFilename: vi.fn(() => "report.pdf"),
      getReceivedBytes: vi.fn(() => 0),
      getSavePath: vi.fn(() => ""),
      getTotalBytes: vi.fn(() => 100),
      on: vi.fn(),
      once: vi.fn(),
      setSaveDialogOptions: vi.fn(),
      setSavePath: vi.fn(),
    };

    handler({
      event: { preventDefault: vi.fn() } as never,
      item: item as never,
      partition: "persist:test",
      webContents: {} as never,
    });

    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "/Downloads/report.pdf",
        properties: expect.arrayContaining(["showOverwriteConfirmation"]),
      }),
    );
  });
});
