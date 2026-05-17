/**
 * Shared primitives for hidden Electron `BrowserWindow` usage.
 *
 * Two consumers today: `hidden-browser.ts` (stateless one-shot render
 * for `webFetchRendered`) and `interactive-browser.ts` (stateful
 * sessions for `browserOpen`/`browserClick`/`browserType`/...). Both
 * need the same sandbox config, the same `did-finish-load` /
 * `did-fail-load` race, and the same close + partition-clear teardown.
 *
 * The window options here MUST stay aligned across consumers — they
 * define the security boundary (no Node access, isolated partition).
 */
import { BrowserWindow, session } from "electron";

/** Sandbox webPreferences shared by every hidden window in the app. */
export const HIDDEN_WINDOW_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} as const;

/**
 * Spawn a hidden, sandboxed BrowserWindow bound to the given session
 * partition. The window has no preload, no Node integration, and
 * isolated storage — safe to point at arbitrary third-party URLs.
 */
export const createHiddenWindow = (partition: string): BrowserWindow =>
  new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      ...HIDDEN_WINDOW_PREFS,
    },
  });

/**
 * Wait for the given `webContents` to finish loading, with a hard
 * timeout and optional abort. Resolves with `200` on `did-finish-load`,
 * rejects on `did-fail-load`, timeout, or signal abort.
 *
 * The caller is responsible for kicking off the load (e.g. via
 * `loadURL`). This helper only listens.
 */
export const waitForPageLoad = (
  win: BrowserWindow,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const wc = win.webContents;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`load timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onFinish = (): void => {
      cleanup();
      resolve(200);
    };
    const onFail = (_e: Electron.Event, code: number, desc: string): void => {
      cleanup();
      reject(new Error(`load failed (${code}) ${desc}`));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      signal?.removeEventListener("abort", onAbort);
    };
    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

/**
 * Close the window (if still alive) and clear its session partition.
 * Both steps are best-effort and swallow errors — by the time we get
 * here we're already in teardown, so any failure (already-destroyed
 * window, partition never touched) is non-fatal.
 */
export const destroyHiddenWindow = async (
  win: BrowserWindow | null,
  partition: string,
): Promise<void> => {
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
    /* swallow */
  }
  try {
    await session.fromPartition(partition).clearStorageData();
  } catch {
    /* swallow */
  }
};

/** `await sleep(ms)` — Promise-friendly setTimeout. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
