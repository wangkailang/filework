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
 * fetches and balloon memory. Stateful interactive sessions live in
 * `interactive-browser.ts`; window setup + teardown primitives are
 * shared via `browser-window-utils.ts`.
 */
import { randomUUID } from "node:crypto";

import type { BrowserWindow } from "electron";

import {
  createHiddenWindow,
  destroyHiddenWindow,
  sleep,
  waitForPageLoad,
} from "./browser-window-utils";

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
   * spawning a window) and during load (waitForPageLoad observes the
   * signal directly).
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
    win = createHiddenWindow(partition);
    const wc = win.webContents;
    const loadPromise = waitForPageLoad(win, timeoutMs, opts.signal);
    void wc.loadURL(url);
    const status = await loadPromise;
    await sleep(settleMs);

    const html = (await wc.executeJavaScript(
      "document.documentElement.outerHTML",
    )) as string;
    return { html, finalUrl: wc.getURL(), status };
  } finally {
    await destroyHiddenWindow(win, partition);
    release();
  }
};
