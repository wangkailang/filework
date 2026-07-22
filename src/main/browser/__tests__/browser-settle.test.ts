import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_SETTLE_INSTALL_SCRIPT,
  beginBrowserSettle,
  buildBrowserDomQuietScript,
} from "../browser-settle";

class FakeWebContents {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  executeJavaScriptInIsolatedWorld = vi.fn();

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

  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0;
  }
}

describe("browser settle scripts", () => {
  it("tracks DOM mutations and requires two quiet animation frames", () => {
    expect(BROWSER_SETTLE_INSTALL_SCRIPT).toContain("MutationObserver");
    const script = buildBrowserDomQuietScript(300, 3_000);
    expect(script).toContain("requestAnimationFrame");
    expect(script).toContain("quietFrames >= 2");
    expect(script).toContain("300");
  });
});

describe("beginBrowserSettle", () => {
  it("finishes when a main-frame navigation stops loading", async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const settle = await beginBrowserSettle(webContents as never, {
      hardTimeoutMs: 100,
    });

    const result = settle.wait();
    webContents.emit(
      "did-start-navigation",
      {},
      "https://example.com/next",
      false,
      true,
    );
    webContents.emit("did-stop-loading");

    await expect(result).resolves.toBe("navigation");
    expect(webContents.listenerCount("did-start-navigation")).toBe(0);
    expect(webContents.listenerCount("did-stop-loading")).toBe(0);
  });

  it("finishes on DOM quiet when no navigation starts", async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce("dom-quiet");
    const settle = await beginBrowserSettle(webContents as never);

    await expect(settle.wait()).resolves.toBe("dom-quiet");
  });

  it("has a hard timeout even if the page-side waiter never resolves", async () => {
    vi.useFakeTimers();
    try {
      const webContents = new FakeWebContents();
      webContents.executeJavaScriptInIsolatedWorld
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(() => new Promise(() => undefined));
      const settle = await beginBrowserSettle(webContents as never, {
        hardTimeoutMs: 50,
      });

      const result = settle.wait();
      await vi.advanceTimersByTimeAsync(51);

      await expect(result).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
