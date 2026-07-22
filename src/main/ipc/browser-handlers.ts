import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { z } from "zod/v4";

import type {
  BrowserApprovalDecision,
  BrowserDownloadState,
  BrowserNavigationCommand,
  BrowserSettings,
  BrowserStateEvent,
  BrowserSurfaceKind,
  BrowserTabState,
} from "../../shared/browser";
import {
  type BrowserManagerContract,
  SHARED_BROWSER_PARTITION,
} from "../browser/browser-manager";
import { respondBrowserApproval } from "../browser/browser-policy";
import {
  createControlledBrowserDownloadHandler,
  setBrowserProfileDownloadHandler,
} from "../browser/browser-profile";
import {
  ARTIFACT_BROWSER_PARTITION,
  assertAgentBrowserUrl,
  validateGuestAttachment,
} from "../browser/security-policy";

export interface BrowserHandlerDependencies {
  clearBrowserProfileData: (partition: string) => Promise<void>;
  getBrowserSettings: () => BrowserSettings;
  getBrowserManager: () => BrowserManagerContract | null;
  getDefaultDownloadDirectory: () => string;
  getMainWindow: () => BrowserWindow | null;
}

const createTabSchema = z
  .object({
    kind: z.enum(["web", "artifact"]),
    url: z.string().optional(),
    activate: z.boolean().optional(),
  })
  .strict();

const tabSchema = z.object({ tabId: z.string().min(1) }).strict();

const navigateSchema = z
  .object({ tabId: z.string().min(1), url: z.string().min(1) })
  .strict();

const commandSchema = z
  .object({
    tabId: z.string().min(1),
    command: z.enum(["back", "forward", "reload", "stop"]),
  })
  .strict();

const viewportSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();

const occludedSchema = z.boolean();
const approvalResponseSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum([
      "allow-once",
      "always-allow",
      "block",
      "approve-once",
      "deny",
    ]),
  })
  .strict();
const clearDataSchema = z.object({ confirmed: z.literal(true) }).strict();

const requireContext = (
  event: IpcMainInvokeEvent,
  dependencies: BrowserHandlerDependencies,
): { manager: BrowserManagerContract; window: BrowserWindow } => {
  const window = dependencies.getMainWindow();
  if (!window || event.sender !== window.webContents) {
    throw new Error("Browser IPC sender is not the main renderer");
  }
  const manager = dependencies.getBrowserManager();
  if (!manager) throw new Error("Browser manager is not available");
  return { manager, window };
};

const requireTab = (
  manager: BrowserManagerContract,
  tabId: string,
): BrowserTabState => {
  const tab = manager.listTabs().find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
  return tab;
};

const normalizeUrl = (kind: BrowserSurfaceKind, raw: string): string => {
  if (kind === "web") return assertAgentBrowserUrl(raw).href;
  validateGuestAttachment({
    partition: ARTIFACT_BROWSER_PARTITION,
    src: raw,
  });
  return new URL(raw).href;
};

export const sendBrowserState = (
  window: BrowserWindow,
  tabs: BrowserTabState[],
): void => {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const event: BrowserStateEvent = {
    type: "state",
    tabs,
    activeTabId: tabs.find((tab) => tab.active)?.id ?? null,
  };
  window.webContents.send("browser:state", event);
};

export const sendBrowserDownloadState = (
  window: BrowserWindow,
  download: BrowserDownloadState,
): void => {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const event: BrowserStateEvent = { type: "download", download };
  window.webContents.send("browser:state", event);
};

export const registerBrowserHandlers = (
  dependencies: BrowserHandlerDependencies,
): void => {
  setBrowserProfileDownloadHandler(
    SHARED_BROWSER_PARTITION,
    createControlledBrowserDownloadHandler({
      getDefaultDirectory: dependencies.getDefaultDownloadDirectory,
      getPreferences: () => {
        const settings = dependencies.getBrowserSettings();
        return {
          askEveryTime: settings.downloadAskEveryTime,
          directory: settings.downloadDirectory,
        };
      },
      onState: (download) => {
        const window = dependencies.getMainWindow();
        if (window) sendBrowserDownloadState(window, download);
      },
    }),
  );

  ipcMain.handle("browser:respondApproval", async (event, raw: unknown) => {
    requireContext(event, dependencies);
    const input = approvalResponseSchema.parse(raw) as {
      requestId: string;
      decision: BrowserApprovalDecision;
    };
    return respondBrowserApproval(input.requestId, input.decision);
  });

  ipcMain.handle("browser:listTabs", async (event) => {
    const { manager } = requireContext(event, dependencies);
    return manager.listTabs();
  });

  ipcMain.handle("browser:createTab", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    const input = createTabSchema.parse(raw);
    return manager.createTab({
      activate: input.activate,
      kind: input.kind,
      url: input.url ? normalizeUrl(input.kind, input.url) : undefined,
    });
  });

  ipcMain.handle("browser:activateTab", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    const { tabId } = tabSchema.parse(raw);
    requireTab(manager, tabId);
    manager.activateTab(tabId);
  });

  ipcMain.handle("browser:closeTab", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    const { tabId } = tabSchema.parse(raw);
    requireTab(manager, tabId);
    await manager.closeTab(tabId);
  });

  ipcMain.handle("browser:navigate", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    const input = navigateSchema.parse(raw);
    const tab = requireTab(manager, input.tabId);
    await manager.navigate(input.tabId, normalizeUrl(tab.kind, input.url));
  });

  ipcMain.handle("browser:command", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    const input = commandSchema.parse(raw) as {
      tabId: string;
      command: BrowserNavigationCommand;
    };
    requireTab(manager, input.tabId);
    manager.command(input.tabId, input.command);
  });

  ipcMain.handle("browser:setViewport", async (event, raw: unknown) => {
    const { manager, window } = requireContext(event, dependencies);
    if (raw === null) {
      manager.setViewport(null);
      return;
    }
    const parsedBounds = viewportSchema.safeParse(raw);
    if (!parsedBounds.success) {
      throw new Error("Browser viewport bounds are invalid");
    }
    const bounds = parsedBounds.data;
    const content = window.getContentBounds();
    if (
      bounds.x + bounds.width > content.width ||
      bounds.y + bounds.height > content.height
    ) {
      throw new Error("Browser viewport bounds exceed the main window");
    }
    manager.setViewport(bounds);
  });

  ipcMain.handle("browser:setOccluded", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    manager.setOccluded(occludedSchema.parse(raw));
  });

  ipcMain.handle("browser:clearData", async (event, raw: unknown) => {
    const { manager } = requireContext(event, dependencies);
    clearDataSchema.parse(raw);
    const webTabIds = manager
      .listTabs()
      .filter((tab) => tab.kind === "web")
      .map((tab) => tab.id);
    for (const tabId of webTabIds) await manager.closeTab(tabId);
    await dependencies.clearBrowserProfileData(SHARED_BROWSER_PARTITION);
    return { closedTabs: webTabIds.length };
  });
};
