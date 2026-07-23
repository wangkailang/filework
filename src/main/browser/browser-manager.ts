import { randomUUID } from "node:crypto";

import {
  type BrowserWindow,
  type Rectangle,
  type WebContents,
  WebContentsView,
} from "electron";

import type {
  BrowserNavigationCommand,
  BrowserSurfaceKind,
  BrowserTabState,
} from "../../shared/browser";
import { initializeBrowserProfile } from "./browser-profile";
import {
  ARTIFACT_BROWSER_PARTITION,
  assertAgentBrowserUrl,
  createControlledWindowOpenHandler,
  validateGuestAttachment,
} from "./security-policy";

export const SHARED_BROWSER_PARTITION = "persist:filework-browser";
export const MAX_BROWSER_TABS = 8;

export interface CreateBrowserTabInput {
  url?: string;
  kind: BrowserSurfaceKind;
  activate?: boolean;
}

export interface BrowserManagerContract {
  createTab(input: CreateBrowserTabInput): Promise<BrowserTabState>;
  listTabs(): BrowserTabState[];
  activateTab(tabId: string): BrowserTabState;
  closeTab(tabId: string): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  command(tabId: string, command: BrowserNavigationCommand): void;
  setViewport(bounds: Rectangle | null): void;
  setOccluded(occluded: boolean): void;
  getWebContents(tabId: string): WebContents;
  getActiveTabId(): string | null;
  dispose(): Promise<void>;
}

export interface BrowserManagerOptions {
  maxTabs?: number;
  now?: () => number;
  createId?: () => string;
  onTabsChanged?: (tabs: BrowserTabState[]) => void;
}

interface ManagedBrowserTab {
  state: BrowserTabState;
  view: WebContentsView;
  lastUsedAt: number;
}

const copyTabState = (state: BrowserTabState): BrowserTabState => ({
  ...state,
});

const finiteInteger = (value: number): number =>
  Number.isFinite(value) ? Math.floor(value) : 0;

export class BrowserManager implements BrowserManagerContract {
  private readonly tabs = new Map<string, ManagedBrowserTab>();
  private readonly maxTabs: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onTabsChanged?: (tabs: BrowserTabState[]) => void;
  private activeTabId: string | null = null;
  private viewport: Rectangle | null = null;
  private occluded = false;
  private disposed = false;

  constructor(
    private readonly window: BrowserWindow,
    options: BrowserManagerOptions = {},
  ) {
    this.maxTabs = options.maxTabs ?? MAX_BROWSER_TABS;
    if (!Number.isInteger(this.maxTabs) || this.maxTabs < 1) {
      throw new Error("Browser maxTabs must be a positive integer");
    }
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.onTabsChanged = options.onTabsChanged;
  }

  async createTab(input: CreateBrowserTabInput): Promise<BrowserTabState> {
    this.assertAvailable();
    const partition = this.partitionFor(input.kind);
    const target = input.url
      ? this.normalizeUrl(input.kind, input.url)
      : undefined;

    await initializeBrowserProfile(partition);
    if (this.tabs.size >= this.maxTabs) {
      const evictionCandidate = [...this.tabs.values()]
        .filter((tab) => tab.state.id !== this.activeTabId)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!evictionCandidate) {
        throw new Error(
          "Browser tab limit reached; no inactive tab can be evicted",
        );
      }
      this.closeManagedTab(evictionCandidate.state.id);
    }

    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setVisible(false);
    this.window.contentView.addChildView(view);

    const id = this.createId();
    const managed: ManagedBrowserTab = {
      state: {
        id,
        kind: input.kind,
        url: target ?? "",
        title: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        active: false,
        crashed: false,
      },
      view,
      lastUsedAt: this.now(),
    };
    this.tabs.set(id, managed);
    this.bindWebContentsEvents(managed);

    if (this.activeTabId === null || input.activate !== false) {
      this.setActiveTab(id);
    } else {
      this.syncView(managed);
      this.emitTabsChanged();
    }

    if (target) {
      try {
        await view.webContents.loadURL(target);
      } catch (error) {
        this.closeManagedTab(id);
        throw error;
      }
    }

    return copyTabState(this.requireTab(id).state);
  }

  listTabs(): BrowserTabState[] {
    return [...this.tabs.values()].map((tab) => copyTabState(tab.state));
  }

  activateTab(tabId: string): BrowserTabState {
    this.assertAvailable();
    this.requireTab(tabId);
    this.setActiveTab(tabId);
    return copyTabState(this.requireTab(tabId).state);
  }

  async closeTab(tabId: string): Promise<void> {
    this.assertAvailable();
    this.requireTab(tabId);
    this.closeManagedTab(tabId);
  }

  async navigate(tabId: string, rawUrl: string): Promise<void> {
    this.assertAvailable();
    const tab = this.requireTab(tabId);
    const target = this.normalizeUrl(tab.state.kind, rawUrl);
    tab.lastUsedAt = this.now();
    tab.state.crashed = false;
    await tab.view.webContents.loadURL(target);
  }

  command(tabId: string, command: BrowserNavigationCommand): void {
    this.assertAvailable();
    const tab = this.requireTab(tabId);
    const contents = tab.view.webContents;
    tab.lastUsedAt = this.now();

    switch (command) {
      case "back":
        if (contents.navigationHistory.canGoBack()) {
          contents.navigationHistory.goBack();
        }
        break;
      case "forward":
        if (contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward();
        }
        break;
      case "reload":
        contents.reload();
        break;
      case "stop":
        contents.stop();
        break;
    }
    this.refreshNavigationState(tab);
    this.emitTabsChanged();
  }

  setViewport(bounds: Rectangle | null): void {
    this.assertAvailable();
    this.viewport = bounds ? this.clampViewport(bounds) : null;
    this.syncViews();
  }

  setOccluded(occluded: boolean): void {
    this.assertAvailable();
    this.occluded = occluded;
    this.syncViews();
  }

  getWebContents(tabId: string): WebContents {
    this.assertAvailable();
    return this.requireTab(tabId).view.webContents;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activeTabId = null;
    for (const tab of this.tabs.values()) {
      tab.view.setVisible(false);
      this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.viewport = null;
    this.emitTabsChanged();
  }

  private partitionFor(kind: BrowserSurfaceKind): string {
    return kind === "web"
      ? SHARED_BROWSER_PARTITION
      : ARTIFACT_BROWSER_PARTITION;
  }

  private normalizeUrl(kind: BrowserSurfaceKind, rawUrl: string): string {
    const partition = this.partitionFor(kind);
    if (kind === "web") return assertAgentBrowserUrl(rawUrl).href;
    validateGuestAttachment({ partition, src: rawUrl });
    return new URL(rawUrl).href;
  }

  private requireTab(tabId: string): ManagedBrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
    return tab;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Browser manager is disposed");
  }

  private closeManagedTab(tabId: string): void {
    const tab = this.requireTab(tabId);
    const orderedIds = [...this.tabs.keys()];
    const closedIndex = orderedIds.indexOf(tabId);
    const wasActive = this.activeTabId === tabId;

    this.tabs.delete(tabId);
    tab.view.setVisible(false);
    this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    if (wasActive) {
      const remainingIds = [...this.tabs.keys()];
      const adjacentId =
        remainingIds[Math.min(closedIndex, remainingIds.length - 1)] ?? null;
      this.activeTabId = adjacentId;
      for (const remaining of this.tabs.values()) {
        remaining.state.active = remaining.state.id === adjacentId;
      }
      if (adjacentId) this.requireTab(adjacentId).lastUsedAt = this.now();
    }
    this.syncViews();
    this.emitTabsChanged();
  }

  private setActiveTab(tabId: string): void {
    this.activeTabId = tabId;
    for (const tab of this.tabs.values()) {
      tab.state.active = tab.state.id === tabId;
      if (tab.state.active) tab.lastUsedAt = this.now();
    }
    // Re-adding an existing child only raises it to the top of the View stack.
    this.window.contentView.addChildView(this.requireTab(tabId).view);
    this.syncViews();
    this.emitTabsChanged();
  }

  private syncViews(): void {
    for (const tab of this.tabs.values()) this.syncView(tab);
  }

  private syncView(tab: ManagedBrowserTab): void {
    if (this.viewport) tab.view.setBounds(this.viewport);
    tab.view.setVisible(
      tab.state.active &&
        !this.occluded &&
        this.viewport !== null &&
        this.viewport.width > 0 &&
        this.viewport.height > 0,
    );
  }

  private clampViewport(bounds: Rectangle): Rectangle {
    const contentBounds = this.window.getContentBounds();
    const contentWidth = Math.max(0, finiteInteger(contentBounds.width));
    const contentHeight = Math.max(0, finiteInteger(contentBounds.height));
    const x = Math.min(contentWidth, Math.max(0, finiteInteger(bounds.x)));
    const y = Math.min(contentHeight, Math.max(0, finiteInteger(bounds.y)));
    const width = Math.min(
      Math.max(0, finiteInteger(bounds.width)),
      contentWidth - x,
    );
    const height = Math.min(
      Math.max(0, finiteInteger(bounds.height)),
      contentHeight - y,
    );
    return { x, y, width, height };
  }

  private bindWebContentsEvents(tab: ManagedBrowserTab): void {
    const { webContents } = tab.view;
    const update = (patch: Partial<BrowserTabState>) => {
      if (!this.tabs.has(tab.state.id)) return;
      Object.assign(tab.state, patch);
      this.refreshNavigationState(tab);
      this.emitTabsChanged();
    };

    webContents.on("page-title-updated", (_event, title) => {
      update({ title });
    });
    webContents.on("page-favicon-updated", (_event, favicons) => {
      update({ faviconUrl: favicons[0] });
    });
    webContents.on("did-start-loading", () => {
      update({ loading: true });
    });
    webContents.on("did-stop-loading", () => {
      update({ loading: false });
    });
    webContents.on("did-navigate", (_event, url) => {
      update({ url, crashed: false });
    });
    webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) update({ url, crashed: false });
    });
    webContents.on("render-process-gone", (_event, details) => {
      update({
        crashed: details.reason !== "clean-exit",
        loading: false,
      });
    });
    webContents.setWindowOpenHandler(
      createControlledWindowOpenHandler((url) => {
        void this.navigate(tab.state.id, url).catch(() => undefined);
      }),
    );
  }

  private refreshNavigationState(tab: ManagedBrowserTab): void {
    if (tab.view.webContents.isDestroyed()) return;
    tab.state.canGoBack = tab.view.webContents.navigationHistory.canGoBack();
    tab.state.canGoForward =
      tab.view.webContents.navigationHistory.canGoForward();
  }

  private emitTabsChanged(): void {
    this.onTabsChanged?.(this.listTabs());
  }
}
