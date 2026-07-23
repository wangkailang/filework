import { describe, expect, it, vi } from "vitest";

import type {
  BrowserObservation,
  BrowserTabState,
} from "../../../../../shared/browser";
import { buildBrowserTools } from "../browser";

const tab = (overrides: Partial<BrowserTabState> = {}): BrowserTabState => ({
  id: "tab-1",
  kind: "web",
  url: "https://example.com/old",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  crashed: false,
  ...overrides,
});

const observation = (
  overrides: Partial<BrowserObservation> = {},
): BrowserObservation => ({
  tabId: "tab-1",
  navigationId: "nav-1",
  snapshotId: "snap-1",
  url: "https://example.com/new",
  title: "New page",
  viewport: { width: 1200, height: 700, deviceScaleFactor: 2 },
  text: "--- BEGIN UNTRUSTED WEB CONTENT ---\nPage body\n--- END UNTRUSTED WEB CONTENT ---",
  elements: [
    {
      ref: "e1",
      tag: "button",
      role: "button",
      name: "Continue",
      rect: { x: 10, y: 20, width: 80, height: 32 },
      visible: true,
    },
  ],
  elementsTruncated: false,
  stateHash: "state-1",
  captureId: "capture-1",
  sourceTrust: "untrusted-web",
  ...overrides,
});

const context = {
  workspace: {} as never,
  signal: new AbortController().signal,
  toolCallId: "call-1",
};

const setup = (options: { supportsMultimodalToolResults?: boolean } = {}) => {
  const manager = {
    listTabs: vi.fn(() => [tab()]),
    getActiveTabId: vi.fn(() => "tab-1"),
    createTab: vi.fn(async () => tab()),
    activateTab: vi.fn(() => tab()),
    closeTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
  };
  const observer = {
    observe: vi.fn(async () => observation()),
  };
  const actions = {
    execute: vi.fn(async () => observation()),
  };
  const captureStore = {
    toModelOutput: vi.fn(() => ({
      type: "file" as const,
      mediaType: "image/png" as const,
      data: { type: "data" as const, data: "cG5n" },
    })),
  };
  const tools = buildBrowserTools({
    manager: manager as never,
    observer,
    actions,
    captureStore,
    supportsMultimodalToolResults:
      options.supportsMultimodalToolResults ?? true,
  });
  return {
    actions,
    captureStore,
    manager,
    observer,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
  };
};

describe("shared browser agent tools", () => {
  it("registers the shared-tab tool surface", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual([
      "browserOpen",
      "browserTabs",
      "browserSwitchTab",
      "browserSnapshot",
      "browserClick",
      "browserType",
      "browserPress",
      "browserScroll",
      "browserClose",
    ]);
  });

  it("reuses the active visible web tab unless newTab is true", async () => {
    const { manager, observer, tools } = setup();
    const open = tools.get("browserOpen");
    await open?.execute(
      { url: "https://example.com/new", newTab: false },
      context,
    );

    expect(manager.createTab).not.toHaveBeenCalled();
    expect(manager.activateTab).toHaveBeenCalledWith("tab-1");
    expect(manager.navigate).toHaveBeenCalledWith(
      "tab-1",
      "https://example.com/new",
    );
    expect(observer.observe).toHaveBeenCalledWith("tab-1", { capture: true });

    await open?.execute(
      { url: "https://example.com/another", newTab: true },
      context,
    );
    expect(manager.createTab).toHaveBeenCalledWith({
      kind: "web",
      url: "https://example.com/another",
      activate: true,
    });
  });

  it("keeps tab listing metadata-only", async () => {
    const { tools } = setup();
    const result = await tools.get("browserTabs")?.execute({}, context);

    expect(result).toEqual({ activeTabId: "tab-1", tabs: [tab()] });
    expect(JSON.stringify(result)).not.toContain("Page body");
  });

  it("requires the snapshot identity on every page action", async () => {
    const { actions, tools } = setup();
    await tools.get("browserClick")?.execute(
      {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "e1",
      },
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        action: { type: "click", ref: "e1" },
      },
      { capture: true },
    );
  });

  it("projects bounded untrusted text, refs, and an in-memory capture", async () => {
    const { captureStore, tools } = setup();
    const snapshot = tools.get("browserSnapshot");
    const projected = await snapshot?.toModelOutput?.({
      toolCallId: "call-1",
      input: { tabId: "tab-1" },
      output: observation(),
    });

    expect(projected).toMatchObject({
      type: "content",
      value: [
        {
          type: "text",
          text: expect.stringContaining("UNTRUSTED WEB CONTENT"),
        },
        { type: "file", mediaType: "image/png" },
      ],
    });
    expect(JSON.stringify(observation())).not.toContain("cG5n");
    expect(captureStore.toModelOutput).toHaveBeenCalledWith("capture-1");
  });

  it("falls back to text when multimodal tool results are unsupported", async () => {
    const { captureStore, tools } = setup({
      supportsMultimodalToolResults: false,
    });
    const snapshot = tools.get("browserSnapshot");
    const projected = await snapshot?.toModelOutput?.({
      toolCallId: "call-1",
      input: { tabId: "tab-1" },
      output: observation(),
    });

    expect(projected).toMatchObject({
      type: "text",
      value: expect.stringContaining("Ref e1"),
    });
    expect(captureStore.toModelOutput).not.toHaveBeenCalled();
  });

  it("places exact action identity and refs before untrusted page text", async () => {
    const { tools } = setup({ supportsMultimodalToolResults: false });
    const snapshot = tools.get("browserSnapshot");
    const projected = await snapshot?.toModelOutput?.({
      toolCallId: "call-1",
      input: { tabId: "tab-1" },
      output: observation(),
    });
    if (!projected || projected.type !== "text") {
      throw new Error("expected text browser projection");
    }

    expect(projected.value).toContain(
      "Action identity (copy these exact values into the next browser action)",
    );
    expect(projected.value).toContain("Navigation: nav-1");
    expect(projected.value).toContain("Snapshot: snap-1");
    expect(projected.value.indexOf("Elements:")).toBeLessThan(
      projected.value.indexOf("Page text:"),
    );
    expect(projected.value.indexOf("Ref e1")).toBeLessThan(
      projected.value.indexOf("Page text:"),
    );
  });

  it("projects unchanged action outcomes with retry guidance", async () => {
    const { tools } = setup({ supportsMultimodalToolResults: false });
    const click = tools.get("browserClick");
    const projected = await click?.toModelOutput?.({
      toolCallId: "call-1",
      input: {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-0",
        ref: "e1",
      },
      output: observation({
        actionResult: {
          outcome: "unchanged",
          settleReason: "dom-quiet",
          previousSnapshotId: "snap-0",
        },
      }),
    });
    if (!projected || projected.type !== "text") {
      throw new Error("expected text browser projection");
    }

    expect(projected.value).toContain("Action result: unchanged");
    expect(projected.value).toContain("Do not repeat the same action");
    expect(projected.value).toContain(
      "This action already returned the fresh observation",
    );
  });

  it("deduplicates an unchanged action observation across browser tools", async () => {
    const { tools } = setup({ supportsMultimodalToolResults: false });
    const snapshot = tools.get("browserSnapshot");
    const click = tools.get("browserClick");

    await snapshot?.toModelOutput?.({
      toolCallId: "snapshot-1",
      input: { tabId: "tab-1" },
      output: observation({ snapshotId: "snap-1" }),
    });
    const projected = await click?.toModelOutput?.({
      toolCallId: "click-1",
      input: {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "e1",
      },
      output: observation({
        snapshotId: "snap-2",
        actionResult: {
          outcome: "unchanged",
          settleReason: "dom-quiet",
          previousSnapshotId: "snap-1",
        },
      }),
    });
    if (!projected || projected.type !== "text") {
      throw new Error("expected text browser projection");
    }

    expect(projected.value).toContain(
      "Page state unchanged from the previous observation",
    );
    expect(projected.value).toContain("Snapshot: snap-2");
    expect(projected.value).not.toContain("Page body");
  });

  it("blocks an exact action retry after an unchanged outcome", async () => {
    const { actions, tools } = setup({
      supportsMultimodalToolResults: false,
    });
    const snapshot = tools.get("browserSnapshot");
    const click = tools.get("browserClick");
    await snapshot?.execute({ tabId: "tab-1" }, context);
    actions.execute.mockResolvedValueOnce(
      observation({
        snapshotId: "snap-2",
        actionResult: {
          outcome: "unchanged",
          settleReason: "dom-quiet",
          previousSnapshotId: "snap-1",
        },
      }),
    );

    await click?.execute(
      {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "e1",
      },
      context,
    );
    await expect(
      click?.execute(
        {
          tabId: "tab-1",
          navigationId: "nav-1",
          snapshotId: "snap-2",
          ref: "e1",
        },
        context,
      ),
    ).rejects.toThrow(/already returned an unchanged page state/i);
    expect(actions.execute).toHaveBeenCalledOnce();
  });

  it("allows the same action after navigation even when page state matches", async () => {
    const { actions, observer, tools } = setup({
      supportsMultimodalToolResults: false,
    });
    const snapshot = tools.get("browserSnapshot");
    const click = tools.get("browserClick");
    await snapshot?.execute({ tabId: "tab-1" }, context);
    actions.execute.mockResolvedValueOnce(
      observation({
        snapshotId: "snap-2",
        actionResult: {
          outcome: "unchanged",
          settleReason: "dom-quiet",
          previousSnapshotId: "snap-1",
        },
      }),
    );
    await click?.execute(
      {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "e1",
      },
      context,
    );

    observer.observe.mockResolvedValueOnce(
      observation({ navigationId: "nav-2", snapshotId: "snap-3" }),
    );
    await snapshot?.execute({ tabId: "tab-1" }, context);

    await expect(
      click?.execute(
        {
          tabId: "tab-1",
          navigationId: "nav-2",
          snapshotId: "snap-3",
          ref: "e1",
        },
        context,
      ),
    ).resolves.toBeDefined();
    expect(actions.execute).toHaveBeenCalledTimes(2);
  });
});
