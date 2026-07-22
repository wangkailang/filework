import type { WebContents } from "electron";

import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserElementRef,
  BrowserObservation,
} from "../../shared/browser";
import type { BrowserManagerContract } from "./browser-manager";
import type {
  BrowserObserveOptions,
  BrowserObserver,
} from "./browser-observer";
import {
  type BrowserSettleController,
  type BrowserSettleOptions,
  beginBrowserSettle,
} from "./browser-settle";

const MAX_INPUT_CHARS = 100_000;
const MAX_KEY_CHARS = 128;

type BrowserObservationProvider = Pick<
  BrowserObserver,
  "observe" | "requireSnapshot"
>;

export interface BrowserActionExecutorOptions {
  platform?: NodeJS.Platform;
  settle?: BrowserSettleOptions;
  beginSettle?: (webContents: WebContents) => Promise<BrowserSettleController>;
}

export class BrowserActionForbiddenError extends Error {
  readonly code = "BROWSER_ACTION_FORBIDDEN";
  readonly risk = "forbidden";

  constructor(message: string) {
    super(message);
    this.name = "BrowserActionForbiddenError";
  }
}

export class BrowserActionExecutor {
  private readonly platform: NodeJS.Platform;
  private readonly beginSettle: (
    webContents: WebContents,
  ) => Promise<BrowserSettleController>;

  constructor(
    private readonly manager: BrowserManagerContract,
    private readonly observer: BrowserObservationProvider,
    options: BrowserActionExecutorOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.beginSettle =
      options.beginSettle ??
      ((webContents) => beginBrowserSettle(webContents, options.settle));
  }

  async execute(
    request: BrowserActionRequest,
    observeOptions: BrowserObserveOptions = {},
  ): Promise<BrowserObservation> {
    const initialSnapshot = this.observer.requireSnapshot(
      request.tabId,
      request.navigationId,
      request.snapshotId,
    );
    this.validateAction(initialSnapshot, request.action);

    this.manager.activateTab(request.tabId);
    const webContents = this.manager.getWebContents(request.tabId);
    const settle = await this.beginSettle(webContents);

    try {
      // Installing the page observer yields to the event loop. A navigation can
      // invalidate refs in that gap, so validate once more immediately before
      // sending any trusted input.
      const currentSnapshot = this.observer.requireSnapshot(
        request.tabId,
        request.navigationId,
        request.snapshotId,
      );
      this.validateAction(currentSnapshot, request.action);

      webContents.focus();
      await this.dispatch(webContents, currentSnapshot, request.action);
      await settle.wait();
      return observeOptions.capture === undefined
        ? await this.observer.observe(request.tabId)
        : await this.observer.observe(request.tabId, observeOptions);
    } catch (error) {
      settle.cancel();
      throw error;
    }
  }

  private validateAction(
    snapshot: BrowserObservation,
    action: BrowserAction,
  ): void {
    if (action.type === "scroll") return;
    if (action.type === "press") {
      this.validateKey(action.key);
      if (action.ref === undefined) return;
    }

    const ref = action.ref;
    if (ref === undefined)
      throw new Error("Browser action requires an element ref");
    const element = this.requireElement(snapshot, ref);
    const inputType = element.inputType?.toLowerCase();
    if (inputType === "file") {
      throw new BrowserActionForbiddenError(
        "File inputs require direct user interaction",
      );
    }
    if (inputType === "password") {
      throw new BrowserActionForbiddenError(
        "Password inputs cannot be controlled by the agent",
      );
    }
    if (
      !element.visible ||
      element.rect.width <= 0 ||
      element.rect.height <= 0
    ) {
      throw new Error(
        `Browser element is not currently visible; refresh the observation: ${element.ref}`,
      );
    }
    if (action.type === "type" && action.text.length > MAX_INPUT_CHARS) {
      throw new Error(`Browser input exceeds ${MAX_INPUT_CHARS} characters`);
    }
  }

  private async dispatch(
    webContents: WebContents,
    snapshot: BrowserObservation,
    action: BrowserAction,
  ): Promise<void> {
    switch (action.type) {
      case "click":
        this.dispatchClick(
          webContents,
          snapshot,
          this.requireElement(snapshot, action.ref),
        );
        return;
      case "type":
        this.dispatchClick(
          webContents,
          snapshot,
          this.requireElement(snapshot, action.ref),
        );
        if (action.clear !== false) this.dispatchSelectAll(webContents);
        await webContents.insertText(action.text);
        return;
      case "press":
        if (action.ref) {
          this.dispatchClick(
            webContents,
            snapshot,
            this.requireElement(snapshot, action.ref),
          );
        }
        this.dispatchKey(webContents, action.key);
        return;
      case "scroll":
        this.dispatchScroll(
          webContents,
          snapshot,
          action.deltaX,
          action.deltaY,
        );
        return;
      default:
        action satisfies never;
    }
  }

  private requireElement(
    snapshot: BrowserObservation,
    ref: string,
  ): BrowserElementRef {
    const element = snapshot.elements.find(
      (candidate) => candidate.ref === ref,
    );
    if (!element) {
      throw new Error(
        `Browser element ref is missing from the latest observation: ${ref}`,
      );
    }
    return element;
  }

  private dispatchClick(
    webContents: WebContents,
    snapshot: BrowserObservation,
    element: BrowserElementRef,
  ): void {
    const { x, y } = this.elementCenter(snapshot, element);
    webContents.sendInputEvent({ type: "mouseMove", x, y });
    webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  private dispatchSelectAll(webContents: WebContents): void {
    const modifier =
      this.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "A",
      ...modifier,
    });
    webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "A",
      ...modifier,
    });
  }

  private dispatchKey(webContents: WebContents, key: string): void {
    webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    if (/^.$/u.test(key)) {
      webContents.sendInputEvent({ type: "char", keyCode: key });
    }
    webContents.sendInputEvent({ type: "keyUp", keyCode: key });
  }

  private dispatchScroll(
    webContents: WebContents,
    snapshot: BrowserObservation,
    deltaX = 0,
    deltaY = 0,
  ): void {
    const { width, height } = snapshot.viewport;
    webContents.sendInputEvent({
      type: "mouseWheel",
      x: Math.max(0, Math.round(width / 2)),
      y: Math.max(0, Math.round(height / 2)),
      deltaX: clampDelta(deltaX, width),
      deltaY: clampDelta(deltaY, height),
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
  }

  private elementCenter(
    snapshot: BrowserObservation,
    element: BrowserElementRef,
  ): { x: number; y: number } {
    const maxX = Math.max(0, Math.floor(snapshot.viewport.width) - 1);
    const maxY = Math.max(0, Math.floor(snapshot.viewport.height) - 1);
    return {
      x: clamp(Math.round(element.rect.x + element.rect.width / 2), 0, maxX),
      y: clamp(Math.round(element.rect.y + element.rect.height / 2), 0, maxY),
    };
  }

  private validateKey(key: string): void {
    if (key.trim().length === 0 || key.length > MAX_KEY_CHARS) {
      throw new Error("Browser key must be a non-empty accelerator key");
    }
  }
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const clampDelta = (value: number, viewportSize: number): number => {
  if (!Number.isFinite(value)) return 0;
  const limit = Math.max(0, Math.floor(viewportSize));
  return clamp(Math.round(value), -limit, limit);
};
