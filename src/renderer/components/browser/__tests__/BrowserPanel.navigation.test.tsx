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
      browserApproval_allowOnce: () => "允许一次",
      browserApproval_alwaysAllow: () => "始终允许此站点",
      browserApproval_approveOnce: () => "批准本次",
      browserApproval_block: () => "阻止",
      browserApproval_deny: () => "拒绝",
      browserApproval_originTitle: () => "允许 Agent 访问此站点？",
      browserApproval_sensitiveTitle: () => "批准网页敏感操作？",
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

import type {
  BrowserApprovalRequest,
  BrowserTabState,
} from "../../../../shared/browser";
import { BrowserPanel } from "../BrowserPanel";

let approvalRequestCallback:
  | ((request: BrowserApprovalRequest) => void)
  | undefined;

const installDom = () => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  Object.defineProperty(window, "filework", {
    configurable: true,
    value: {
      browser: {
        setViewport: vi.fn(async () => undefined),
        onApprovalRequest: vi.fn(
          (callback: (request: BrowserApprovalRequest) => void) => {
            approvalRequestCallback = callback;
            return () => undefined;
          },
        ),
        respondApproval: vi.fn(async () => true),
      },
      openExternal: vi.fn(async () => undefined),
    },
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("CustomEvent", window.CustomEvent);
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
    approvalRequestCallback = undefined;
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

  it("hides the native browser view while an origin approval prompt is shown", async () => {
    const document = installDom();
    browserHookState.value = makeController(
      makeTab("https://example.com/"),
      vi.fn(async () => undefined),
    );
    root = createRoot(document.querySelector("#root") as HTMLElement);

    await act(async () => {
      root?.render(<BrowserPanel url="" />);
      await Promise.resolve();
    });
    const setViewport = window.filework.browser.setViewport as ReturnType<
      typeof vi.fn
    >;
    setViewport.mockClear();

    await act(async () => {
      approvalRequestCallback?.({
        requestId: "request-1",
        taskId: "task-1",
        kind: "origin",
        origin: "https://example.com",
      });
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-browser-access-prompt="origin"]'),
    ).not.toBeNull();
    expect(setViewport).toHaveBeenLastCalledWith(null);
  });
});
