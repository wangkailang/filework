import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  Toaster: () => null,
}));

vi.mock("../components/browser/context", () => ({
  BrowserRouterProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../components/chat/ChatPanel", () => ({
  ChatPanel: () => <div data-chat-panel="true" />,
}));

vi.mock("../components/chat/ChatSessionProvider", () => ({
  ChatSessionProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../components/command/CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("../components/dock/ContextDock", () => ({
  ContextDock: (props: {
    activeTab: string;
    onAutomationRunDetailsOpenedAsChat?: () => void;
  }) => (
    <section data-active-tab={props.activeTab} data-context-dock="true">
      <button
        type="button"
        data-open-automation-run-details="true"
        onClick={() => props.onAutomationRunDetailsOpenedAsChat?.()}
      >
        查看详情
      </button>
    </section>
  ),
}));

vi.mock("../components/dock/DockMenu", () => ({
  DockMenu: () => null,
}));

vi.mock("../components/layout/LeftRail", () => ({
  LeftRail: (props: {
    automationsOpen: boolean;
    onOpenAutomations: () => void;
    railTab: string;
  }) => (
    <aside
      data-automations-open={props.automationsOpen ? "true" : "false"}
      data-left-rail="true"
      data-rail-tab={props.railTab}
    >
      <button
        type="button"
        data-open-automations="true"
        onClick={props.onOpenAutomations}
      >
        自动化
      </button>
    </aside>
  ),
  RailExpandButton: () => null,
}));

vi.mock("../components/layout/SettingsModal", () => ({
  SettingsModal: () => null,
}));

vi.mock("../components/onboarding/GitHubConnectModal", () => ({
  GitHubConnectModal: () => null,
}));

vi.mock("../components/onboarding/GitLabConnectModal", () => ({
  GitLabConnectModal: () => null,
}));

vi.mock("../components/onboarding/WelcomeScreen", () => ({
  WelcomeScreen: () => <div data-welcome-screen="true" />,
}));

vi.mock("../i18n/i18n-react", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../i18n/i18n-util.sync", () => ({
  loadAllLocales: vi.fn(),
}));

import { App } from "../App";

const noop = () => {};

const makeFilework = () => ({
  addRecentWorkspace: vi.fn(),
  automations: {
    onOpenTriage: vi.fn(() => noop),
  },
  getRecentWorkspaces: vi.fn(async () => [
    {
      label: "repo",
      metadata: JSON.stringify({ kind: "local", path: "/tmp/repo" }),
      path: "/tmp/repo",
    },
  ]),
  github: {
    cloneRepo: vi.fn(async () => ({ root: "/tmp/repo" })),
  },
  gitlab: {
    cloneRepo: vi.fn(async () => ({ root: "/tmp/repo" })),
  },
  local: {
    probeGit: vi.fn(async () => ({
      currentBranch: "main",
      isGitRepo: true,
    })),
  },
  onStreamToolResult: vi.fn(() => noop),
  onWorkspaceBranchChanged: vi.fn(() => noop),
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
};

const installDom = () => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
  };

  Object.defineProperty(window, "filework", {
    configurable: true,
    value: makeFilework(),
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  const navigatorMock = {
    ...window.navigator,
    language: "zh-CN",
  };

  Object.defineProperty(window, "navigator", {
    configurable: true,
    value: navigatorMock,
  });

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("MouseEvent", window.MouseEvent);
  vi.stubGlobal("navigator", navigatorMock);
  vi.stubGlobal("localStorage", localStorageMock);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return { document };
};

const clickSelector = async (document: Document, selector: string) => {
  const target = document.querySelector(selector) as HTMLElement | null;
  if (!target) throw new Error(`Missing target: ${selector}`);

  await act(async () => {
    target.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flushEffects();
};

describe("App automations dock behavior", () => {
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("keeps the right automations dock open when run details open in chat", async () => {
    const { document } = installDom();
    root = createRoot(document.getElementById("root") as HTMLElement);

    await act(async () => {
      root?.render(<App />);
    });
    await flushEffects();

    await clickSelector(document, '[data-open-automations="true"]');

    expect(
      document
        .querySelector('[data-context-dock="true"]')
        ?.getAttribute("data-active-tab"),
    ).toBe("automations");

    await clickSelector(document, '[data-open-automation-run-details="true"]');

    expect(
      document
        .querySelector('[data-left-rail="true"]')
        ?.getAttribute("data-rail-tab"),
    ).toBe("chats");
    expect(
      document
        .querySelector('[data-context-dock="true"]')
        ?.getAttribute("data-active-tab"),
    ).toBe("automations");
  });
});
