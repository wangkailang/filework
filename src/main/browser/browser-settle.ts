import type { WebContents } from "electron";

const BROWSER_SETTLE_WORLD_ID = 1_002;
const DEFAULT_DOM_QUIET_MS = 300;
const DEFAULT_HARD_TIMEOUT_MS = 3_000;

export type BrowserSettleReason =
  | "navigation"
  | "dom-quiet"
  | "timeout"
  | "cancelled";

export interface BrowserSettleOptions {
  domQuietMs?: number;
  hardTimeoutMs?: number;
}

export interface BrowserSettleController {
  wait(): Promise<BrowserSettleReason>;
  cancel(): void;
}

export const BROWSER_SETTLE_INSTALL_SCRIPT = `(() => {
  const STATE_KEY = "__fileworkBrowserSettleV1";
  const previous = globalThis[STATE_KEY];
  if (previous && previous.document === document && previous.observer) {
    previous.lastMutation = performance.now();
    return true;
  }
  try {
    previous && previous.observer && previous.observer.disconnect();
  } catch {}
  const state = {
    document,
    lastMutation: performance.now(),
    observer: null,
  };
  state.observer = new MutationObserver(() => {
    state.lastMutation = performance.now();
  });
  state.observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  globalThis[STATE_KEY] = state;
  return true;
})()`;

export const buildBrowserDomQuietScript = (
  domQuietMs = DEFAULT_DOM_QUIET_MS,
  hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS,
): string => {
  const quietMs = positiveInteger(domQuietMs, "DOM quiet duration");
  const timeoutMs = positiveInteger(hardTimeoutMs, "settle timeout");
  return `(() => new Promise((resolve) => {
    const state = globalThis.__fileworkBrowserSettleV1;
    if (!state || state.document !== document) {
      resolve("unavailable");
      return;
    }
    const startedAt = performance.now();
    let quietFrames = 0;
    const check = (now) => {
      if (now - startedAt >= ${timeoutMs}) {
        resolve("timeout");
        return;
      }
      if (now - state.lastMutation >= ${quietMs}) {
        quietFrames += 1;
      } else {
        quietFrames = 0;
      }
      if (quietFrames >= 2) {
        resolve("dom-quiet");
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }))()`;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Browser ${label} must be positive`);
  }
  return Math.max(1, Math.floor(value));
};

class BrowserSettleControllerImpl implements BrowserSettleController {
  private readonly domQuietMs: number;
  private readonly hardTimeoutMs: number;
  private navigationStarted = false;
  private navigationCompleted = false;
  private cancelled = false;
  private finished = false;
  private waitPromise?: Promise<BrowserSettleReason>;
  private resolveWait?: (reason: BrowserSettleReason) => void;
  private timeout?: ReturnType<typeof setTimeout>;

  private readonly onDidStartNavigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) this.navigationStarted = true;
  };

  private readonly onDidStopLoading = () => {
    if (!this.navigationStarted) return;
    this.navigationCompleted = true;
    if (this.resolveWait) this.finish("navigation");
  };

  constructor(
    private readonly webContents: WebContents,
    options: BrowserSettleOptions,
  ) {
    this.domQuietMs = positiveInteger(
      options.domQuietMs ?? DEFAULT_DOM_QUIET_MS,
      "DOM quiet duration",
    );
    this.hardTimeoutMs = positiveInteger(
      options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS,
      "settle timeout",
    );
    webContents.on("did-start-navigation", this.onDidStartNavigation);
    webContents.on("did-stop-loading", this.onDidStopLoading);
  }

  async prepare(): Promise<void> {
    try {
      await this.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SETTLE_WORLD_ID,
        [{ code: BROWSER_SETTLE_INSTALL_SCRIPT }],
      );
    } catch (error) {
      this.cancel();
      throw new Error("Unable to install browser settle observer", {
        cause: error,
      });
    }
  }

  wait(): Promise<BrowserSettleReason> {
    if (this.waitPromise) return this.waitPromise;
    if (this.cancelled) return Promise.resolve("cancelled");

    this.waitPromise = new Promise<BrowserSettleReason>((resolve) => {
      this.resolveWait = resolve;
      this.timeout = setTimeout(
        () => this.finish("timeout"),
        this.hardTimeoutMs,
      );

      if (this.navigationCompleted) {
        this.finish("navigation");
        return;
      }

      void this.webContents
        .executeJavaScriptInIsolatedWorld(BROWSER_SETTLE_WORLD_ID, [
          {
            code: buildBrowserDomQuietScript(
              this.domQuietMs,
              this.hardTimeoutMs,
            ),
          },
        ])
        .then((result: unknown) => {
          if (this.navigationStarted || this.finished) return;
          if (result === "dom-quiet") this.finish("dom-quiet");
          if (result === "timeout" || result === "unavailable") {
            this.finish("timeout");
          }
        })
        .catch(() => {
          // The isolated world is commonly destroyed by a navigation. The
          // navigation events or the main-process hard timeout settle instead.
        });
    });
    return this.waitPromise;
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    if (this.resolveWait) {
      this.finish("cancelled");
    } else {
      this.finished = true;
      this.cleanup();
    }
  }

  private finish(reason: BrowserSettleReason): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.resolveWait?.(reason);
  }

  private cleanup(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.webContents.removeListener(
      "did-start-navigation",
      this.onDidStartNavigation,
    );
    this.webContents.removeListener("did-stop-loading", this.onDidStopLoading);
  }
}

export const beginBrowserSettle = async (
  webContents: WebContents,
  options: BrowserSettleOptions = {},
): Promise<BrowserSettleController> => {
  const controller = new BrowserSettleControllerImpl(webContents, options);
  await controller.prepare();
  return controller;
};
