import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const browserHookState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      browser_back: () => "后退",
      browser_close: () => "关闭浏览器",
      browser_failed_to_load: () => "页面加载失败",
      browser_forward: () => "前进",
      browser_open_external: () => "在系统浏览器中打开",
      browser_reload: () => "刷新",
      browser_start_hint: () => "在地址栏输入网址",
      browser_start_title: () => "浏览网页",
      browser_stop: () => "停止",
      browser_url_placeholder: () => "输入网址…",
    },
  }),
}));

vi.mock("../useBrowserTabs", () => ({
  useBrowserTabs: () => browserHookState.value,
}));

import type { BrowserTabState } from "../../../../shared/browser";
import { BrowserPanel } from "../BrowserPanel";

const installDom = () => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  Object.defineProperty(window, "filework", {
    configurable: true,
    value: {
      browser: { setViewport: vi.fn(async () => undefined) },
      openExternal: vi.fn(async () => undefined),
    },
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
};

const makeTab = (url: string): BrowserTabState => ({
  id: "tab-1",
  kind: "web",
  url,
  title: "State of JS",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  crashed: false,
});

const makeController = (
  tab: BrowserTabState,
  openUrl: ReturnType<typeof vi.fn>,
) => ({
  tabs: [tab],
  activeTab: tab,
  ready: true,
  error: null,
  createTab: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  navigate: vi.fn(),
  command: vi.fn(),
  openUrl,
});

describe("BrowserPanel external URL requests", () => {
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not replay an unchanged external URL after the page redirects", async () => {
    const document = installDom();
    const openUrl = vi.fn(async () => undefined);
    const requestedUrl = "https://stateofjs.com/";
    browserHookState.value = makeController(makeTab(requestedUrl), openUrl);
    root = createRoot(document.querySelector("#root") as HTMLElement);

    await act(async () => {
      root?.render(<BrowserPanel url={requestedUrl} />);
      await Promise.resolve();
    });
    expect(openUrl).toHaveBeenCalledTimes(1);

    browserHookState.value = makeController(
      makeTab("https://stateofjs.com/en-US"),
      openUrl,
    );
    await act(async () => {
      root?.render(<BrowserPanel url={requestedUrl} />);
      await Promise.resolve();
    });

    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
