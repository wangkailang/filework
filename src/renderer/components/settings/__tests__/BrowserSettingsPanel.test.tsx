import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserSettings } from "../../../../shared/browser";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      browserSettings_allowed: () => "Allowed",
      browserSettings_askEveryTime: () => "Ask every time",
      browserSettings_blocked: () => "Blocked",
      browserSettings_cancel: () => "Cancel",
      browserSettings_chooseDirectory: () => "Choose directory",
      browserSettings_clearAction: () => "Clear browsing data",
      browserSettings_cleared: () => "Browser data cleared.",
      browserSettings_clearConfirm: () => "Clear now",
      browserSettings_clearDescription: () =>
        "Cookies, storage, cache, service workers, and history will be cleared.",
      browserSettings_clearTitle: () => "Clear browser data?",
      browserSettings_data: () => "Browsing data",
      browserSettings_dataHint: () => "This signs out every site.",
      browserSettings_defaultDirectory: () => "System Downloads folder",
      browserSettings_description: () => "Browser privacy controls.",
      browserSettings_developerMode: () => "Developer mode",
      browserSettings_developerModeHint: () => "Off by default.",
      browserSettings_downloadDirectory: () => "Download directory",
      browserSettings_downloads: () => "Downloads",
      browserSettings_downloadsHint: () => "Downloads are saved safely.",
      browserSettings_emptyOrigins: () => "No saved sites",
      browserSettings_error: ({ reason }: { reason: string }) => reason,
      browserSettings_loading: () => "Loading browser settings…",
      browserSettings_origins: () => "Site access",
      browserSettings_originsHint: () => "Only site origins are shown.",
      browserSettings_askEveryTimeHint: () => "Use the native save dialog.",
      browserSettings_revokeOrigin: ({ origin }: { origin: string }) =>
        `Revoke ${origin}`,
      browserSettings_title: () => "Browser",
    },
  }),
}));

vi.mock("../../ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <button
        type="button"
        data-browser-clear-confirm="true"
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
    ) : null,
}));

import { BrowserSettingsPanel } from "../BrowserSettingsPanel";

const INITIAL_SETTINGS: BrowserSettings = {
  sharedSurfaceEnabled: true,
  allowedOrigins: ["https://allowed.example"],
  blockedOrigins: ["https://blocked.example"],
  developerModeEnabled: false,
  downloadAskEveryTime: true,
  downloadDirectory: "",
};

const installDom = () => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { document, window };
};

describe("BrowserSettingsPanel", () => {
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows only saved origins and keeps developer mode off by default", async () => {
    const { document, window } = installDom();
    Object.assign(window, {
      filework: {
        browserSettings: {
          get: vi.fn(async () => INITIAL_SETTINGS),
          set: vi.fn(async () => INITIAL_SETTINGS),
        },
        browser: { clearData: vi.fn(async () => ({ closedTabs: 0 })) },
        openDirectory: vi.fn(async () => null),
      },
    });
    root = createRoot(document.getElementById("root") as HTMLElement);

    await act(async () => {
      root?.render(<BrowserSettingsPanel />);
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("https://allowed.example");
    expect(document.body.textContent).toContain("https://blocked.example");
    expect(
      document.querySelector('[data-browser-origin="allowed"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-browser-origin="blocked"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector('[data-browser-developer-mode="true"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(document.body.textContent).not.toContain("session-token-secret");
  });

  it("revokes origins, selects a download directory, and confirms data clearing", async () => {
    const { document, window } = installDom();
    let settings = { ...INITIAL_SETTINGS };
    const set = vi.fn(async (patch: Partial<BrowserSettings>) => {
      settings = { ...settings, ...patch };
      return settings;
    });
    const clearData = vi.fn(async () => ({ closedTabs: 2 }));
    const openDirectory = vi.fn(async () => "/Users/test/Downloads");
    Object.assign(window, {
      filework: {
        browserSettings: {
          get: vi.fn(async () => settings),
          set,
        },
        browser: { clearData },
        openDirectory,
      },
    });
    root = createRoot(document.getElementById("root") as HTMLElement);

    await act(async () => {
      root?.render(<BrowserSettingsPanel />);
      await Promise.resolve();
    });

    await act(async () => {
      (
        document.querySelector(
          '[aria-label="Revoke https://allowed.example"]',
        ) as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledWith({ allowedOrigins: [] });

    await act(async () => {
      (
        document.querySelector(
          '[data-browser-download-directory="true"]',
        ) as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(openDirectory).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({
      downloadAskEveryTime: false,
      downloadDirectory: "/Users/test/Downloads",
    });

    await act(async () => {
      (
        document.querySelector(
          '[data-browser-clear-data="true"]',
        ) as HTMLElement
      ).click();
    });
    await act(async () => {
      (
        document.querySelector(
          '[data-browser-clear-confirm="true"]',
        ) as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(clearData).toHaveBeenCalledOnce();
  });
});
