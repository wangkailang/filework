import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { BrowserPanel } from "../BrowserPanel";
import { shouldOccludeBrowser } from "../BrowserViewport";

describe("BrowserPanel shared browser shell", () => {
  beforeEach(() => {
    browserHookState.value = {
      tabs: [],
      activeTab: null,
      ready: false,
      error: null,
      createTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
      navigate: vi.fn(),
      command: vi.fn(),
      openUrl: vi.fn(),
    };
  });

  it("renders native-view chrome and no renderer webview", () => {
    const html = renderToStaticMarkup(<BrowserPanel url="" />);

    expect(html).toContain('data-browser-tab-strip="true"');
    expect(html).toContain('data-browser-new-tab="true"');
    expect(html).toContain('data-browser-address="true"');
    expect(html).toContain('data-browser-start-page="true"');
    expect(html).toContain('data-browser-viewport="true"');
    expect(html).not.toContain("<webview");
  });

  it("renders active tab loading and navigation state", () => {
    const activeTab = {
      id: "tab-1",
      kind: "web",
      url: "https://example.com/path",
      title: "Example Docs",
      loading: true,
      canGoBack: true,
      canGoForward: false,
      active: true,
      crashed: false,
    };
    browserHookState.value = {
      ...browserHookState.value,
      tabs: [activeTab],
      activeTab,
      ready: true,
    };

    const html = renderToStaticMarkup(<BrowserPanel url="" />);

    expect(html).toContain("Example Docs");
    expect(html).toContain('data-browser-loading="true"');
    expect(html).toContain('aria-label="停止"');
    expect(html).toContain('aria-label="后退"');
    expect(html).toContain('value="https://example.com/path"');
  });

  it("renders a recovery action after the page renderer crashes", () => {
    const activeTab = {
      id: "tab-crashed",
      kind: "web",
      url: "https://example.com",
      title: "Crashed",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      active: true,
      crashed: true,
    };
    browserHookState.value = {
      ...browserHookState.value,
      tabs: [activeTab],
      activeTab,
      ready: true,
    };

    const html = renderToStaticMarkup(<BrowserPanel url="" />);

    expect(html).toContain('data-browser-crash="true"');
    expect(html).toContain('data-browser-recover="true"');
    expect(html).toContain("页面加载失败");
  });
});

describe("browser native view occlusion", () => {
  it("hides the native view behind settings and inactive dock surfaces", () => {
    expect(
      shouldOccludeBrowser({
        hasWorkspace: true,
        dockOpen: true,
        dockTab: "web",
        modalOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldOccludeBrowser({
        hasWorkspace: true,
        dockOpen: true,
        dockTab: "web",
        modalOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldOccludeBrowser({
        hasWorkspace: true,
        dockOpen: true,
        dockTab: "preview",
        modalOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldOccludeBrowser({
        hasWorkspace: false,
        dockOpen: false,
        dockTab: "web",
        modalOpen: false,
      }),
    ).toBe(true);
  });
});
