import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BrowserDownloadState,
  BrowserNavigationCommand,
  BrowserSurfaceKind,
  BrowserTabState,
} from "../../../shared/browser";

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface BrowserTabsController {
  tabs: BrowserTabState[];
  downloads: BrowserDownloadState[];
  activeTab: BrowserTabState | null;
  ready: boolean;
  error: string | null;
  createTab: (input: {
    kind: BrowserSurfaceKind;
    url?: string;
    activate?: boolean;
  }) => Promise<BrowserTabState>;
  activateTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  command: (tabId: string, command: BrowserNavigationCommand) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
}

export const useBrowserTabs = (): BrowserTabsController => {
  const [tabs, setTabs] = useState<BrowserTabState[]>([]);
  const [downloads, setDownloads] = useState<BrowserDownloadState[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.filework.browser.onState((event) => {
      if (!mounted) return;
      if (event.type === "state") {
        setTabs(event.tabs);
        return;
      }
      setDownloads((current) =>
        [
          event.download,
          ...current.filter((item) => item.id !== event.download.id),
        ].slice(0, 3),
      );
    });
    window.filework.browser
      .listTabs()
      .then((nextTabs) => {
        if (mounted) setTabs(nextTabs);
      })
      .catch((cause) => {
        if (mounted) setError(messageFor(cause));
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const run = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        setError(null);
        return await operation();
      } catch (cause) {
        setError(messageFor(cause));
        throw cause;
      }
    },
    [],
  );

  const createTab = useCallback<BrowserTabsController["createTab"]>(
    async (input) => {
      const created = await run(() => window.filework.browser.createTab(input));
      setTabs((current) => [
        ...current.filter((tab) => tab.id !== created.id),
        created,
      ]);
      return created;
    },
    [run],
  );

  const activateTab = useCallback(
    async (tabId: string) => {
      await run(() => window.filework.browser.activateTab(tabId));
    },
    [run],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      await run(() => window.filework.browser.closeTab(tabId));
    },
    [run],
  );

  const navigate = useCallback(
    async (tabId: string, url: string) => {
      await run(() => window.filework.browser.navigate(tabId, url));
    },
    [run],
  );

  const command = useCallback(
    async (tabId: string, nextCommand: BrowserNavigationCommand) => {
      await run(() => window.filework.browser.command(tabId, nextCommand));
    },
    [run],
  );

  const openUrl = useCallback(
    async (url: string) => {
      const kind: BrowserSurfaceKind = url.startsWith("local-file://")
        ? "artifact"
        : "web";
      const active = tabsRef.current.find((tab) => tab.active) ?? null;
      if (active?.kind === kind) {
        if (active.url !== url) await navigate(active.id, url);
        return;
      }
      await createTab({ kind, url, activate: true });
    },
    [createTab, navigate],
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.active) ?? null,
    [tabs],
  );

  return {
    tabs,
    downloads,
    activeTab,
    ready,
    error,
    createTab,
    activateTab,
    closeTab,
    navigate,
    command,
    openUrl,
  };
};
