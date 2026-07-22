import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTabState } from "../../../shared/browser";

const electronState = vi.hoisted(() => ({
  views: [] as Array<{
    options: Record<string, unknown>;
    visible: boolean;
    bounds: Electron.Rectangle | null;
    setVisible: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    webContents: FakeWebContents;
  }>,
}));

const profileState = vi.hoisted(() => ({
  partitions: [] as string[],
}));

class FakeWebContents {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private currentUrl = "";
  private destroyed = false;
  title = "";
  loading = false;
  windowOpenHandler: ((details: { url: string }) => { action: "deny" }) | null =
    null;

  navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };

  loadURL = vi.fn(async (url: string) => {
    this.currentUrl = url;
    this.emit("did-navigate", {}, url);
  });
  reload = vi.fn();
  stop = vi.fn();
  close = vi.fn(() => {
    this.destroyed = true;
  });
  isDestroyed = vi.fn(() => this.destroyed);
  getURL = vi.fn(() => this.currentUrl);
  getTitle = vi.fn(() => this.title);
  isLoading = vi.fn(() => this.loading);
  setWindowOpenHandler = vi.fn(
    (handler: (details: { url: string }) => { action: "deny" }) => {
      this.windowOpenHandler = handler;
    },
  );

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeAllListeners = vi.fn((event?: string) => {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  });

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

vi.mock("electron", () => ({
  WebContentsView: class FakeWebContentsView {
    options: Record<string, unknown>;
    visible = false;
    bounds: Electron.Rectangle | null = null;
    webContents = new FakeWebContents();
    setVisible = vi.fn((visible: boolean) => {
      this.visible = visible;
    });
    setBounds = vi.fn((bounds: Electron.Rectangle) => {
      this.bounds = bounds;
    });

    constructor(options: Record<string, unknown>) {
      this.options = options;
      electronState.views.push(this);
    }
  },
}));

vi.mock("../browser-profile", () => ({
  initializeBrowserProfile: vi.fn(async (partition: string) => {
    profileState.partitions.push(partition);
  }),
}));

import { BrowserManager } from "../browser-manager";

const createWindow = (width = 1000, height = 700) => {
  const children: unknown[] = [];
  return {
    children,
    contentView: {
      addChildView: vi.fn((view: unknown) => {
        const previous = children.indexOf(view);
        if (previous >= 0) children.splice(previous, 1);
        children.push(view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
    },
    getContentBounds: vi.fn(() => ({ x: 100, y: 80, width, height })),
  };
};

describe("BrowserManager", () => {
  beforeEach(() => {
    electronState.views.length = 0;
    profileState.partitions.length = 0;
    vi.clearAllMocks();
  });

  it("activates the first tab and shows only the active view", async () => {
    const window = createWindow();
    const manager = new BrowserManager(window as never);
    manager.setViewport({ x: 20, y: 30, width: 600, height: 400 });

    const first = await manager.createTab({ kind: "web" });
    const second = await manager.createTab({ kind: "web", activate: false });

    expect(first.active).toBe(true);
    expect(manager.getActiveTabId()).toBe(first.id);
    expect(manager.listTabs().map((tab) => tab.active)).toEqual([true, false]);
    expect(electronState.views[0].visible).toBe(true);
    expect(electronState.views[1].visible).toBe(false);

    manager.activateTab(second.id);
    expect(electronState.views[0].visible).toBe(false);
    expect(electronState.views[1].visible).toBe(true);
  });

  it("isolates web and artifact tabs in separate profiles", async () => {
    const manager = new BrowserManager(createWindow() as never);

    await manager.createTab({ kind: "web" });
    await manager.createTab({ kind: "web", activate: false });
    await manager.createTab({ kind: "artifact", activate: false });

    const partitions = electronState.views.map(
      (view) =>
        (view.options.webPreferences as { partition: string }).partition,
    );
    expect(partitions).toEqual([
      "persist:filework-browser",
      "persist:filework-browser",
      "artifact-preview",
    ]);
    expect(profileState.partitions).toEqual([
      "persist:filework-browser",
      "persist:filework-browser",
      "artifact-preview",
    ]);
  });

  it("selects an adjacent tab and destroys contents when closing", async () => {
    const window = createWindow();
    const manager = new BrowserManager(window as never);
    const first = await manager.createTab({ kind: "web" });
    const second = await manager.createTab({ kind: "web" });
    const third = await manager.createTab({ kind: "web" });
    manager.activateTab(second.id);

    await manager.closeTab(second.id);

    expect(manager.getActiveTabId()).toBe(third.id);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(
      electronState.views[1],
    );
    expect(electronState.views[1].webContents.close).toHaveBeenCalledOnce();
    expect(manager.listTabs().map((tab) => tab.id)).toEqual([
      first.id,
      third.id,
    ]);
  });

  it("caps tabs at eight and evicts only the oldest inactive tab", async () => {
    let clock = 0;
    const manager = new BrowserManager(createWindow() as never, {
      now: () => ++clock,
    });
    const tabs: BrowserTabState[] = [];
    for (let index = 0; index < 8; index++) {
      tabs.push(await manager.createTab({ kind: "web" }));
    }
    manager.activateTab(tabs[1].id);

    const ninth = await manager.createTab({ kind: "web" });

    expect(manager.listTabs()).toHaveLength(8);
    expect(manager.listTabs().some((tab) => tab.id === tabs[0].id)).toBe(false);
    expect(manager.listTabs().some((tab) => tab.id === tabs[1].id)).toBe(true);
    expect(manager.getActiveTabId()).toBe(ninth.id);
    expect(electronState.views[0].webContents.close).toHaveBeenCalledOnce();
  });

  it("clamps renderer viewport bounds to the window content area", async () => {
    const manager = new BrowserManager(createWindow() as never);
    await manager.createTab({ kind: "web" });

    manager.setViewport({ x: -50, y: 680, width: 2_000, height: 100 });

    expect(electronState.views[0].bounds).toEqual({
      x: 0,
      y: 680,
      width: 1000,
      height: 20,
    });
  });

  it("mirrors serializable navigation and crash state", async () => {
    const onTabsChanged = vi.fn();
    const manager = new BrowserManager(createWindow() as never, {
      onTabsChanged,
    });
    const tab = await manager.createTab({ kind: "web" });
    const contents = electronState.views[0].webContents;
    contents.title = "Example";
    contents.emit("page-title-updated", {}, "Example");
    contents.emit("page-favicon-updated", {}, ["https://example.com/icon.png"]);
    contents.emit("did-start-loading");
    contents.emit("render-process-gone", {}, { reason: "crashed" });

    expect(manager.listTabs()[0]).toMatchObject({
      id: tab.id,
      title: "Example",
      faviconUrl: "https://example.com/icon.png",
      loading: false,
      crashed: true,
    });
    expect(onTabsChanged).toHaveBeenCalled();
    expect(JSON.stringify(manager.listTabs())).not.toContain("webContents");
  });
});
