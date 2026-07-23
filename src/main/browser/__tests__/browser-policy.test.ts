import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BrowserApprovalDecision,
  type BrowserApprovalRequest,
  type BrowserObservation,
  type BrowserSettings,
  type BrowserTabState,
  DEFAULT_BROWSER_SETTINGS,
} from "../../../shared/browser";
import type { BeforeToolCallHook } from "../../core/agent/tool-registry";
import {
  buildBrowserPolicyHook,
  clearBrowserPolicyTask,
} from "../browser-policy";

const browserTab = (url = "https://example.com/page"): BrowserTabState => ({
  id: "tab-1",
  kind: "web",
  url,
  title: "Page",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  crashed: false,
});

const page = (): BrowserObservation => ({
  tabId: "tab-1",
  navigationId: "nav-1",
  snapshotId: "snap-1",
  url: "https://example.com/page",
  title: "Page",
  viewport: { width: 1000, height: 700, deviceScaleFactor: 1 },
  text: "--- BEGIN UNTRUSTED WEB CONTENT ---\nPage\n--- END UNTRUSTED WEB CONTENT ---",
  elements: [
    {
      ref: "read-link",
      tag: "a",
      role: "link",
      name: "Docs",
      href: "https://example.com/docs",
      rect: { x: 0, y: 0, width: 30, height: 20 },
      visible: true,
    },
    {
      ref: "buy",
      tag: "button",
      role: "button",
      name: "Buy now",
      rect: { x: 0, y: 30, width: 60, height: 20 },
      visible: true,
    },
    {
      ref: "password",
      tag: "input",
      role: "textbox",
      inputType: "password",
      rect: { x: 0, y: 60, width: 60, height: 20 },
      visible: true,
    },
  ],
  elementsTruncated: false,
  stateHash: "state-1",
  sourceTrust: "untrusted-web",
});

const call = (
  hook: BeforeToolCallHook,
  toolName: string,
  args: Record<string, unknown>,
) =>
  hook(
    { toolName, toolCallId: `call-${toolName}`, args },
    {
      workspace: {} as never,
      signal: new AbortController().signal,
      toolCallId: `call-${toolName}`,
    },
  );

const setup = (
  decisions: BrowserApprovalDecision[],
  initial: Partial<BrowserSettings> = {},
  requireSnapshot: () => BrowserObservation = page,
) => {
  let currentTab = browserTab();
  let settings: BrowserSettings = { ...DEFAULT_BROWSER_SETTINGS, ...initial };
  const requests: BrowserApprovalRequest[] = [];
  const requestApproval = vi.fn(async (request: BrowserApprovalRequest) => {
    requests.push(request);
    const decision = decisions.shift();
    if (!decision) throw new Error("missing approval decision");
    return decision;
  });
  const hook = buildBrowserPolicyHook({
    manager: { listTabs: () => [currentTab] },
    observer: { requireSnapshot },
    sender: { isDestroyed: () => false, send: vi.fn() } as never,
    taskId: "task-policy",
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    requestApproval,
  });
  return {
    hook,
    requests,
    requestApproval,
    setUrl: (url: string) => {
      currentTab = browserTab(url);
    },
    settings: () => settings,
  };
};

afterEach(() => clearBrowserPolicyTask("task-policy"));

describe("browser origin and sensitive-action policy", () => {
  it("asks on first origin use and scopes allow-once to task + origin", async () => {
    const harness = setup(["allow-once"]);
    await expect(
      call(harness.hook, "browserSnapshot", { tabId: "tab-1" }),
    ).resolves.toEqual({ allow: true });
    await expect(
      call(harness.hook, "browserSnapshot", { tabId: "tab-1" }),
    ).resolves.toEqual({ allow: true });

    expect(harness.requestApproval).toHaveBeenCalledTimes(1);
    expect(harness.requests[0]).toMatchObject({
      taskId: "task-policy",
      kind: "origin",
      origin: "https://example.com",
    });
    expect(harness.settings().allowedOrigins).toEqual([]);
  });

  it("persists always-allow for only the approved origin", async () => {
    const harness = setup(["always-allow"]);
    await call(harness.hook, "browserOpen", {
      url: "https://example.com/start",
    });

    expect(harness.settings().allowedOrigins).toEqual(["https://example.com"]);
    expect(harness.settings().blockedOrigins).toEqual([]);
  });

  it("gives block priority over allow", async () => {
    const harness = setup([], {
      allowedOrigins: ["https://example.com"],
      blockedOrigins: ["https://example.com"],
    });

    await expect(
      call(harness.hook, "browserSnapshot", { tabId: "tab-1" }),
    ).resolves.toMatchObject({
      allow: false,
      reason: expect.stringMatching(/blocked/i),
    });
    expect(harness.requestApproval).not.toHaveBeenCalled();
  });

  it("requires a new origin grant after redirect and does not infer grants from manual browsing", async () => {
    const harness = setup(["allow-once", "allow-once"]);
    await call(harness.hook, "browserSnapshot", { tabId: "tab-1" });
    harness.setUrl("https://redirected.example.org/welcome");
    await call(harness.hook, "browserSnapshot", { tabId: "tab-1" });

    expect(harness.requests.map((request) => request.origin)).toEqual([
      "https://example.com",
      "https://redirected.example.org",
    ]);
  });

  it("forbids password controls and separately approves external effects", async () => {
    const forbidden = setup([], {
      allowedOrigins: ["https://example.com"],
    });
    await expect(
      call(forbidden.hook, "browserType", {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "password",
        text: "do-not-send",
      }),
    ).resolves.toMatchObject({
      allow: false,
      denialSource: "policy",
    });

    const sensitive = setup(["approve-once"], {
      allowedOrigins: ["https://example.com"],
    });
    await expect(
      call(sensitive.hook, "browserClick", {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "buy",
      }),
    ).resolves.toEqual({ allow: true });
    expect(sensitive.requests[0]).toMatchObject({
      kind: "sensitive-action",
      action: {
        type: "click",
        target: "Buy now",
        risk: "external-effect",
      },
    });
  });

  it("marks stale snapshots separately from user denials", async () => {
    const harness = setup(
      [],
      { allowedOrigins: ["https://example.com"] },
      () => {
        throw new Error(
          "Browser snapshot is stale; request a fresh observation",
        );
      },
    );

    await expect(
      call(harness.hook, "browserType", {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "password",
        text: "do-not-send",
      }),
    ).resolves.toMatchObject({
      allow: false,
      denialSource: "stale",
    });
  });

  it("marks an explicit sensitive-action rejection as a user denial", async () => {
    const harness = setup(["deny"], {
      allowedOrigins: ["https://example.com"],
    });

    await expect(
      call(harness.hook, "browserClick", {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "buy",
      }),
    ).resolves.toMatchObject({
      allow: false,
      denialSource: "user",
    });
  });
});
