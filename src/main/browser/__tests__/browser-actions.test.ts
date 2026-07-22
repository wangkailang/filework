import { describe, expect, it, vi } from "vitest";

import type {
  BrowserActionRequest,
  BrowserObservation,
} from "../../../shared/browser";
import {
  BrowserActionExecutor,
  BrowserActionForbiddenError,
} from "../browser-actions";

const makeObservation = (inputType = "text"): BrowserObservation => ({
  tabId: "tab-1",
  navigationId: "nav-1",
  snapshotId: "snap-1",
  url: "https://example.com",
  title: "Example",
  viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
  text: "--- BEGIN UNTRUSTED WEB CONTENT ---\npage\n--- END UNTRUSTED WEB CONTENT ---",
  elements: [
    {
      ref: "e1",
      role: "textbox",
      tag: "input",
      inputType,
      rect: { x: 10, y: 20, width: 100, height: 40 },
      visible: true,
    },
  ],
  elementsTruncated: false,
  sourceTrust: "untrusted-web",
});

class FakeWebContents {
  focus = vi.fn();
  sendInputEvent = vi.fn();
  insertText = vi.fn(async () => undefined);
}

const makeHarness = (observation = makeObservation()) => {
  const webContents = new FakeWebContents();
  const freshObservation = { ...observation, snapshotId: "snap-2" };
  const observer = {
    requireSnapshot: vi.fn(
      (tabId: string, navigationId: string, snapshotId: string) => {
        if (
          tabId !== observation.tabId ||
          navigationId !== observation.navigationId
        ) {
          throw new Error("navigation stale");
        }
        if (snapshotId !== observation.snapshotId) {
          throw new Error("snapshot stale");
        }
        return observation;
      },
    ),
    observe: vi.fn(async () => freshObservation),
  };
  const manager = {
    activateTab: vi.fn(),
    getWebContents: vi.fn(() => webContents),
  };
  const settle = {
    wait: vi.fn(async () => "dom-quiet" as const),
    cancel: vi.fn(),
  };
  const beginSettle = vi.fn(async () => settle);
  const executor = new BrowserActionExecutor(
    manager as never,
    observer as never,
    { platform: "darwin", beginSettle },
  );

  return {
    beginSettle,
    executor,
    freshObservation,
    manager,
    observer,
    settle,
    webContents,
  };
};

const request = (
  action: BrowserActionRequest["action"],
): BrowserActionRequest => ({
  tabId: "tab-1",
  navigationId: "nav-1",
  snapshotId: "snap-1",
  action,
});

describe("BrowserActionExecutor", () => {
  it("rejects stale navigation and snapshots before dispatching input", async () => {
    const harness = makeHarness();
    harness.observer.requireSnapshot.mockImplementation(() => {
      throw new Error("snapshot stale");
    });

    await expect(
      harness.executor.execute(request({ type: "click", ref: "e1" })),
    ).rejects.toThrow(/snapshot/i);
    expect(harness.webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(harness.beginSettle).not.toHaveBeenCalled();
  });

  it("revalidates the snapshot after installing settle listeners", async () => {
    const harness = makeHarness();
    harness.observer.requireSnapshot
      .mockReturnValueOnce(makeObservation())
      .mockImplementationOnce(() => {
        throw new Error("navigation stale");
      });

    await expect(
      harness.executor.execute(request({ type: "click", ref: "e1" })),
    ).rejects.toThrow(/navigation/i);
    expect(harness.webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(harness.settle.cancel).toHaveBeenCalledOnce();
  });

  it("clicks the center of the cached rectangle with trusted mouse input", async () => {
    const harness = makeHarness();

    const result = await harness.executor.execute(
      request({ type: "click", ref: "e1" }),
    );

    expect(harness.manager.activateTab).toHaveBeenCalledWith("tab-1");
    expect(harness.webContents.focus).toHaveBeenCalledOnce();
    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "mouseMove", x: 60, y: 40 }],
      [
        {
          type: "mouseDown",
          x: 60,
          y: 40,
          button: "left",
          clickCount: 1,
        },
      ],
      [
        {
          type: "mouseUp",
          x: 60,
          y: 40,
          button: "left",
          clickCount: 1,
        },
      ],
    ]);
    expect(harness.settle.wait).toHaveBeenCalledOnce();
    expect(harness.observer.observe).toHaveBeenCalledWith("tab-1");
    expect(result).toBe(harness.freshObservation);
  });

  it("focuses, selects existing content, and inserts trusted text", async () => {
    const harness = makeHarness();

    await harness.executor.execute(
      request({ type: "type", ref: "e1", text: "replacement" }),
    );

    expect(harness.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "mouseMove", x: 60, y: 40 }],
      [
        {
          type: "mouseDown",
          x: 60,
          y: 40,
          button: "left",
          clickCount: 1,
        },
      ],
      [
        {
          type: "mouseUp",
          x: 60,
          y: 40,
          button: "left",
          clickCount: 1,
        },
      ],
      [{ type: "keyDown", keyCode: "A", metaKey: true }],
      [{ type: "keyUp", keyCode: "A", metaKey: true }],
    ]);
    expect(harness.webContents.insertText).toHaveBeenCalledWith("replacement");
    expect(
      harness.webContents.sendInputEvent.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(harness.webContents.insertText.mock.invocationCallOrder[0]);
  });

  it("clamps wheel deltas to one viewport in either direction", async () => {
    const harness = makeHarness();

    await harness.executor.execute(
      request({ type: "scroll", deltaX: 5_000, deltaY: -5_000 }),
    );

    expect(harness.webContents.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 800,
      deltaY: -600,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
  });

  it("returns a fresh observation after a soft settle timeout", async () => {
    const harness = makeHarness();
    harness.settle.wait.mockResolvedValueOnce("timeout");

    const result = await harness.executor.execute(
      request({ type: "click", ref: "e1" }),
    );

    expect(harness.observer.observe).toHaveBeenCalledWith("tab-1");
    expect(result).toBe(harness.freshObservation);
  });

  it("dispatches press as trusted keyboard input", async () => {
    const harness = makeHarness();

    await harness.executor.execute(
      request({ type: "press", ref: "e1", key: "Enter" }),
    );

    expect(harness.webContents.sendInputEvent.mock.calls.slice(-2)).toEqual([
      [{ type: "keyDown", keyCode: "Enter" }],
      [{ type: "keyUp", keyCode: "Enter" }],
    ]);
  });

  it.each([
    "file",
    "password",
  ])("forbids targeting %s inputs", async (inputType) => {
    const harness = makeHarness(makeObservation(inputType));

    const pending = harness.executor.execute(
      request({ type: "type", ref: "e1", text: "secret" }),
    );

    await expect(pending).rejects.toBeInstanceOf(BrowserActionForbiddenError);
    expect(harness.webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(harness.beginSettle).not.toHaveBeenCalled();
  });
});
