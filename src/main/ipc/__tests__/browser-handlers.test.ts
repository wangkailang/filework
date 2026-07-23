import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcState = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { sender: unknown }, payload?: unknown) => unknown
  >(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: { sender: unknown }, payload?: unknown) => unknown,
      ) => {
        ipcState.handlers.set(channel, handler);
      },
    ),
  },
}));

import { registerBrowserHandlers } from "../browser-handlers";

const tab = {
  id: "tab-1",
  kind: "web" as const,
  url: "https://example.com",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  crashed: false,
};

const createHarness = () => {
  const sender = {};
  const window = {
    webContents: sender,
    getContentBounds: vi.fn(() => ({
      x: 100,
      y: 80,
      width: 1000,
      height: 700,
    })),
  };
  const manager = {
    createTab: vi.fn(async () => tab),
    listTabs: vi.fn(() => [tab]),
    activateTab: vi.fn(),
    closeTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    command: vi.fn(),
    getActiveTabId: vi.fn(() => tab.id),
    getWebContents: vi.fn(() => ({
      capturePage: vi.fn(async () => ({
        toDataURL: () => "data:image/png;base64,cGFnZS1wcmV2aWV3",
      })),
    })),
    setViewport: vi.fn(),
    setOccluded: vi.fn(),
  };
  const clearBrowserProfileData = vi.fn(async () => undefined);
  registerBrowserHandlers({
    clearBrowserProfileData,
    getBrowserSettings: () => ({
      sharedSurfaceEnabled: true,
      allowedOrigins: [],
      blockedOrigins: [],
      developerModeEnabled: false,
      downloadAskEveryTime: true,
      downloadDirectory: "",
    }),
    getBrowserManager: () => manager as never,
    getDefaultDownloadDirectory: () => "/Downloads",
    getMainWindow: () => window as never,
  });

  const invoke = (channel: string, payload?: unknown, eventSender = sender) => {
    const handler = ipcState.handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler({ sender: eventSender }, payload);
  };

  return { clearBrowserProfileData, invoke, manager, sender, window };
};

describe("browser IPC handlers", () => {
  beforeEach(() => {
    ipcState.handlers.clear();
    vi.clearAllMocks();
  });

  it("serves the fixed browser API to the main renderer", async () => {
    const { invoke, manager } = createHarness();

    await expect(invoke("browser:listTabs")).resolves.toEqual([tab]);
    await expect(
      invoke("browser:createTab", {
        kind: "web",
        url: "https://example.com/path",
      }),
    ).resolves.toEqual(tab);
    expect(manager.createTab).toHaveBeenCalledWith({
      activate: undefined,
      kind: "web",
      url: "https://example.com/path",
    });

    await invoke("browser:activateTab", { tabId: "tab-1" });
    await invoke("browser:closeTab", { tabId: "tab-1" });
    await invoke("browser:navigate", {
      tabId: "tab-1",
      url: "https://example.com/next",
    });
    await invoke("browser:command", { tabId: "tab-1", command: "reload" });
    expect(manager.activateTab).toHaveBeenCalledWith("tab-1");
    expect(manager.closeTab).toHaveBeenCalledWith("tab-1");
    expect(manager.navigate).toHaveBeenCalledWith(
      "tab-1",
      "https://example.com/next",
    );
    expect(manager.command).toHaveBeenCalledWith("tab-1", "reload");
  });

  it("captures the active web tab for an in-renderer approval backdrop", async () => {
    const { invoke, manager } = createHarness();

    await expect(invoke("browser:captureActiveTabPreview")).resolves.toBe(
      "data:image/png;base64,cGFnZS1wcmV2aWV3",
    );
    expect(manager.getWebContents).toHaveBeenCalledWith("tab-1");
  });

  it("rejects calls not sent by the main renderer", async () => {
    const { invoke } = createHarness();

    await expect(invoke("browser:listTabs", undefined, {})).rejects.toThrow(
      /sender/i,
    );
  });

  it("rejects privileged URL schemes before calling the manager", async () => {
    const { invoke, manager } = createHarness();

    await expect(
      invoke("browser:createTab", { kind: "web", url: "file:///etc/passwd" }),
    ).rejects.toThrow(/scheme/i);
    await expect(
      invoke("browser:navigate", {
        tabId: "tab-1",
        url: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/scheme/i);
    expect(manager.createTab).not.toHaveBeenCalled();
    expect(manager.navigate).not.toHaveBeenCalled();
  });

  it("rejects unknown tabs and malformed commands", async () => {
    const { invoke, manager } = createHarness();
    manager.listTabs.mockReturnValue([]);

    await expect(
      invoke("browser:activateTab", { tabId: "missing" }),
    ).rejects.toThrow(/tab/i);
    await expect(
      invoke("browser:command", { tabId: "tab-1", command: "evaluate" }),
    ).rejects.toThrow();
  });

  it("accepts only viewport bounds inside the main window", async () => {
    const { invoke, manager } = createHarness();
    const bounds = { x: 300, y: 200, width: 600, height: 400 };

    await invoke("browser:setViewport", bounds);
    await invoke("browser:setViewport", null);
    await invoke("browser:setOccluded", true);
    expect(manager.setViewport).toHaveBeenNthCalledWith(1, bounds);
    expect(manager.setViewport).toHaveBeenNthCalledWith(2, null);
    expect(manager.setOccluded).toHaveBeenCalledWith(true);

    await expect(
      invoke("browser:setViewport", {
        x: -1,
        y: 0,
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow(/bounds/i);
    await expect(
      invoke("browser:setViewport", {
        x: 900,
        y: 0,
        width: 200,
        height: 100,
      }),
    ).rejects.toThrow(/bounds/i);
  });

  it("closes ordinary web tabs before clearing the shared browser profile", async () => {
    const { clearBrowserProfileData, invoke, manager } = createHarness();
    manager.listTabs.mockReturnValue([
      tab,
      {
        ...tab,
        id: "artifact-1",
        kind: "artifact",
        url: "local-file://open?path=/tmp/report.pdf",
      },
    ] as never);

    await expect(
      invoke("browser:clearData", { confirmed: true }),
    ).resolves.toEqual({ closedTabs: 1 });

    expect(manager.closeTab).toHaveBeenCalledTimes(1);
    expect(manager.closeTab).toHaveBeenCalledWith("tab-1");
    expect(clearBrowserProfileData).toHaveBeenCalledWith(
      "persist:filework-browser",
    );
    expect(manager.closeTab.mock.invocationCallOrder[0]).toBeLessThan(
      clearBrowserProfileData.mock.invocationCallOrder[0],
    );
  });

  it("requires an explicit renderer confirmation before clearing data", async () => {
    const { clearBrowserProfileData, invoke } = createHarness();

    await expect(
      invoke("browser:clearData", { confirmed: false }),
    ).rejects.toThrow();
    expect(clearBrowserProfileData).not.toHaveBeenCalled();
  });
});
