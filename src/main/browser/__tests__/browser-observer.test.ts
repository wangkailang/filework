import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

import { BrowserCaptureStore } from "../browser-capture-store";
import { BROWSER_OBSERVER_SCRIPT, BrowserObserver } from "../browser-observer";

const installRects = (document: Document) => {
  let top = 0;
  for (const element of document.querySelectorAll("*")) {
    const elementTop = top;
    top += 24;
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 10,
        y: elementTop,
        left: 10,
        top: elementTop,
        right: 110,
        bottom: elementTop + 20,
        width: 100,
        height: 20,
      }),
    });
  }
};

const evaluateObserverScript = (
  document: Document,
  window: Window,
  world: Record<string, unknown>,
) => {
  const evaluate = new Function(
    "document",
    "window",
    "location",
    "globalThis",
    `return ${BROWSER_OBSERVER_SCRIPT}`,
  );
  return evaluate(document, window, { href: "https://example.com" }, world) as {
    text: string;
    elements: Array<{
      ref: string;
      tag: string;
      name?: string;
      value?: string;
      inputType?: string;
    }>;
  };
};

describe("isolated browser observation script", () => {
  it("keeps refs stable and assigns new elements monotonically", () => {
    const parsed = parseHTML(
      "<!doctype html><html><body><button>One</button><button>Two</button></body></html>",
    );
    Object.defineProperty(parsed.window, "innerWidth", { value: 800 });
    Object.defineProperty(parsed.window, "innerHeight", { value: 600 });
    const world = {};
    installRects(parsed.document);

    const first = evaluateObserverScript(
      parsed.document,
      parsed.window as unknown as Window,
      world,
    );
    const next = parsed.document.createElement("button");
    next.textContent = "Three";
    parsed.document.body.append(next);
    installRects(parsed.document);
    const second = evaluateObserverScript(
      parsed.document,
      parsed.window as unknown as Window,
      world,
    );

    expect(first.elements.map((element) => element.ref)).toEqual(["e1", "e2"]);
    expect(second.elements.map((element) => element.ref)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(parsed.document.querySelector("[data-browser-ref]")).toBeNull();
  });

  it("redacts password, token, hidden, and credential autofill values", () => {
    const parsed = parseHTML(`<!doctype html><html><body>
      <input type="text" value="public">
      <input type="password" value="hunter2">
      <input type="hidden" value="hidden-secret">
      <input name="api_token" value="token-secret">
      <input autocomplete="current-password" value="stored-secret">
    </body></html>`);
    Object.defineProperty(parsed.window, "innerWidth", { value: 800 });
    Object.defineProperty(parsed.window, "innerHeight", { value: 600 });
    installRects(parsed.document);

    const result = evaluateObserverScript(
      parsed.document,
      parsed.window as unknown as Window,
      {},
    );

    expect(result.elements[0]?.value).toBe("public");
    expect(result.elements.slice(1).map((element) => element.value)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
  });

  it("observes open shadow roots and accessible child frames", () => {
    const parsed = parseHTML(
      "<!doctype html><html><body><section id='host'></section><iframe></iframe></body></html>",
    );
    const frame = parseHTML(
      "<!doctype html><html><body><button>Frame action</button></body></html>",
    );
    Object.defineProperty(parsed.window, "innerWidth", { value: 800 });
    Object.defineProperty(parsed.window, "innerHeight", { value: 600 });
    const host = parsed.document.querySelector("#host");
    const iframe = parsed.document.querySelector("iframe");
    expect(host).not.toBeNull();
    expect(iframe).not.toBeNull();
    const shadow = host?.attachShadow({ mode: "open" });
    if (shadow) shadow.innerHTML = "<button>Shadow action</button>";
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      value: frame.document,
    });
    installRects(parsed.document);
    installRects(frame.document);
    const shadowButton = shadow?.querySelector("button");
    Object.defineProperty(shadowButton, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 20, y: 20, width: 100, height: 20 }),
    });

    const result = evaluateObserverScript(
      parsed.document,
      parsed.window as unknown as Window,
      {},
    );

    expect(result.elements.map((element) => element.name)).toContain(
      "Shadow action",
    );
    expect(result.elements.map((element) => element.name)).toContain(
      "Frame action",
    );
    expect(result.text).toContain("Shadow action");
    expect(result.text).toContain("Frame action");
  });

  it("returns an explicit placeholder for an inaccessible frame", () => {
    const parsed = parseHTML(
      "<!doctype html><html><body><iframe></iframe></body></html>",
    );
    Object.defineProperty(parsed.window, "innerWidth", { value: 800 });
    Object.defineProperty(parsed.window, "innerHeight", { value: 600 });
    const iframe = parsed.document.querySelector("iframe");
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => {
        throw new Error("cross origin");
      },
    });
    installRects(parsed.document);

    const result = evaluateObserverScript(
      parsed.document,
      parsed.window as unknown as Window,
      {},
    );

    expect(result.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "iframe",
          name: "Unavailable or cross-origin frame",
        }),
      ]),
    );
  });

  it("truncates page text inside the isolated world", () => {
    const parsed = parseHTML(
      `<!doctype html><html><body>${"x".repeat(70_000)}</body></html>`,
    );
    Object.defineProperty(parsed.window, "innerWidth", { value: 800 });
    Object.defineProperty(parsed.window, "innerHeight", { value: 600 });

    const result = evaluateObserverScript(
      parsed.document,
      parsed.window as unknown as Window,
      {},
    );

    expect(result.text.length).toBe(60_000);
  });
});

class FakeWebContents {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  raw: Record<string, unknown> = {
    url: "https://example.com",
    title: "Example",
    viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
    text: "page body",
    elements: [],
  };
  executeJavaScriptInIsolatedWorld = vi.fn(async () => this.raw);
  capturePage = vi.fn(async () => ({
    toPNG: () => Buffer.from("png-binary-secret"),
  }));

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      listeners.filter((candidate) => candidate !== listener),
    );
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const makeTab = () => ({
  id: "tab-1",
  kind: "web" as const,
  url: "https://example.com",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  crashed: false,
});

describe("BrowserObserver", () => {
  it("invalidates navigation and snapshot guards after navigation", async () => {
    let id = 0;
    const webContents = new FakeWebContents();
    const manager = {
      listTabs: () => [makeTab()],
      getWebContents: () => webContents,
    };
    const observer = new BrowserObserver(manager as never, {
      createId: () => `id-${++id}`,
    });

    const first = await observer.observe("tab-1");
    const second = await observer.observe("tab-1");
    expect(second.navigationId).toBe(first.navigationId);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(() =>
      observer.requireSnapshot(
        first.tabId,
        first.navigationId,
        first.snapshotId,
      ),
    ).toThrow(/snapshot/i);

    webContents.emit(
      "did-start-navigation",
      {},
      "https://example.com/next",
      false,
      true,
    );
    const third = await observer.observe("tab-1");
    expect(third.navigationId).not.toBe(first.navigationId);
    expect(() =>
      observer.requireSnapshot(
        first.tabId,
        first.navigationId,
        second.snapshotId,
      ),
    ).toThrow(/navigation/i);
  });

  it("bounds page text and elements before returning untrusted data", async () => {
    const webContents = new FakeWebContents();
    webContents.raw = {
      ...webContents.raw,
      text: "x".repeat(1_000),
      elements: Array.from({ length: 200 }, (_, index) => ({
        ref: `e${index + 1}`,
        tag: "button",
        rect: { x: 0, y: index, width: 20, height: 10 },
        visible: index % 2 === 1,
      })),
    };
    const observer = new BrowserObserver(
      {
        listTabs: () => [makeTab()],
        getWebContents: () => webContents,
      } as never,
      { maxTextChars: 100 },
    );

    const result = await observer.observe("tab-1");

    expect(result.text).toContain("BEGIN UNTRUSTED WEB CONTENT");
    expect(result.text.length).toBeLessThan(200);
    expect(result.elements).toHaveLength(150);
    expect(
      result.elements.slice(0, 100).every((element) => element.visible),
    ).toBe(true);
    expect(result.elementsTruncated).toBe(true);
  });

  it("stores screenshot bytes out of band and returns only a capture id", async () => {
    const webContents = new FakeWebContents();
    const store = new BrowserCaptureStore({ createId: () => "capture-1" });
    const observer = new BrowserObserver(
      {
        listTabs: () => [makeTab()],
        getWebContents: () => webContents,
      } as never,
      { captureStore: store },
    );

    const result = await observer.observe("tab-1", { capture: true });

    expect(result.captureId).toBe("capture-1");
    expect(JSON.stringify(result)).not.toContain("png-binary-secret");
    expect(store.get("capture-1")?.toString()).toBe("png-binary-secret");
  });
});
