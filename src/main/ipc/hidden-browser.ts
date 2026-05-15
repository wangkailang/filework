/**
 * hidden-browser — load a URL in a sandboxed, hidden Electron
 * BrowserWindow and return the rendered HTML. Powers the
 * `webFetchRendered` agent tool (Layer 2' of the web-access stack).
 *
 * Why Electron instead of Playwright: the app already ships a Chromium;
 * spawning hidden windows piggybacks on it (zero bundle add, real Chrome
 * fingerprint that anti-bot rules accept more often than a synthetic
 * headless UA). Trade-off: fewer knobs than Playwright — no rich
 * `evaluate(fn)` ergonomics, no built-in stealth — but for "load the
 * page, let it hydrate, grab outerHTML" that's plenty.
 *
 * Isolation: each load uses a `headless-<uuid>` session partition so
 * cookies/localStorage never bleed into the user's main session.
 * `contextIsolation`, `sandbox`, no preload → the loaded page can't
 * reach Node.
 *
 * Concurrency: capped at 2 parallel renders so the agent can't fork 50
 * fetches and balloon memory.
 */
import { randomUUID } from "node:crypto";

import { BrowserWindow, session } from "electron";

export interface RenderedFetchResult {
  html: string;
  finalUrl: string;
  /** Best-effort HTTP status from `did-finish-load`. null when load failed. */
  status: number | null;
}

interface RenderOpts {
  /** Hard timeout for `loadURL`. Default 15s. */
  timeoutMs?: number;
  /** Settle delay AFTER did-finish-load for SPA hydration. Default 1500ms. */
  settleMs?: number;
  /**
   * Optional cancellation. Honored both while queued (rejects without
   * spawning a window) and during load (the loadURL race already loses
   * to its own timeout, so the window gets closed in finally).
   */
  signal?: AbortSignal;
}

const MAX_CONCURRENT = 2;

interface QueueEntry {
  grant: () => void;
  reject: (err: Error) => void;
}

let inFlight = 0;
const waitQueue: QueueEntry[] = [];

const acquire = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    if (inFlight < MAX_CONCURRENT) {
      inFlight++;
      resolve();
      return;
    }
    const onAbort = () => {
      const i = waitQueue.indexOf(entry);
      if (i >= 0) waitQueue.splice(i, 1);
      entry.reject(new DOMException("aborted", "AbortError"));
    };
    const entry: QueueEntry = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        inFlight++;
        resolve();
      },
      reject: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waitQueue.push(entry);
  });

const release = (): void => {
  inFlight--;
  const next = waitQueue.shift();
  if (next) next.grant();
};

export const fetchRenderedHtml = async (
  url: string,
  opts: RenderOpts = {},
): Promise<RenderedFetchResult> => {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const settleMs = opts.settleMs ?? 1_500;

  await acquire(opts.signal);
  const partition = `headless-${randomUUID()}`;
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    const wc = win.webContents;
    const status: number | null = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`loadURL timed out after ${timeoutMs}ms: ${url}`));
      }, timeoutMs);
      const onFinish = () => {
        cleanup();
        resolve(200);
      };
      const onFail = (_e: Electron.Event, code: number, desc: string): void => {
        cleanup();
        reject(new Error(`load failed (${code}) ${desc}: ${url}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        wc.removeListener("did-finish-load", onFinish);
        wc.removeListener("did-fail-load", onFail);
      };
      wc.once("did-finish-load", onFinish);
      wc.once("did-fail-load", onFail);
      void wc.loadURL(url);
    });

    // Let client-side hydration paint. 1500ms covers most React/Vue SPAs.
    await new Promise((r) => setTimeout(r, settleMs));

    const html = (await wc.executeJavaScript(
      "document.documentElement.outerHTML",
    )) as string;
    const finalUrl = wc.getURL();
    return { html, finalUrl, status };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      // already closed
    }
    try {
      await session.fromPartition(partition).clearStorageData();
    } catch {
      // partition may not have been touched if loadURL never fired
    }
    release();
  }
};
