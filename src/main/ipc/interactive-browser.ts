/**
 * interactive-browser — stateful browsing sessions on top of hidden
 * Electron BrowserWindows. Powers the `browserOpen / browserClick /
 * browserType / browserSnapshot / browserClose` agent tools that close
 * the GAIA-style interactive-browsing gap (the stateless
 * `webFetchRendered` only renders once and discards state).
 *
 * Model:
 *   - `openBrowserSession(url)` spawns a hidden, sandboxed BrowserWindow
 *     with its own `headless-session-<uuid>` partition (cookies/
 *     localStorage isolated from the user's main session, persistent
 *     within the session).
 *   - Every interactive call (click/type) is keyed by a session id and
 *     a per-page `ref` id (auto-assigned `data-aix-ref` attribute on
 *     interactive elements), not a CSS selector. This dramatically
 *     reduces LLM brittleness vs. raw selectors.
 *   - Returns a compact snapshot after each action: page URL/title +
 *     reader-mode markdown + a list of visible interactive elements with
 *     their refs.
 *
 * Lifecycle:
 *   - Up to {@link MAX_SESSIONS} live at once; opening past the cap
 *     evicts the least-recently-used.
 *   - Idle reaper closes sessions untouched for {@link IDLE_TIMEOUT_MS}.
 *   - Sessions cleared on `app:before-quit` to avoid leaking windows.
 *
 * Safety:
 *   - All page-side scripts pass LLM-provided values through
 *     `JSON.stringify` before splicing into the JS source, so a malicious
 *     `ref` or `text` can't break out of the string literal.
 *   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
 *     mean the loaded page cannot reach Node APIs.
 */
import { randomUUID } from "node:crypto";

import { app, BrowserWindow, session } from "electron";

import { extractReadable } from "../core/agent/tools/web-extract";

// ─── Limits ──────────────────────────────────────────────────────────

const MAX_SESSIONS = 4;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REAPER_INTERVAL_MS = 30 * 1000;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 1_500;
const NAV_WAIT_TIMEOUT_MS = 10_000;
const POST_ACTION_SETTLE_MS = 200;
const POST_NAV_SETTLE_MS = 800;
const MAX_ELEMENTS_PER_SNAPSHOT = 150;
const MARKDOWN_CAP_BYTES = 60_000;

// ─── Types ───────────────────────────────────────────────────────────

export interface InteractiveElement {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  /** Visible text (innerText) truncated to ~80 chars. */
  text?: string;
  placeholder?: string;
  /** Current input value, truncated. */
  value?: string;
  href?: string;
  /** True when at least partially inside the viewport. */
  visible: boolean;
}

export interface InteractiveSnapshot {
  sessionId: string;
  url: string;
  title: string;
  markdown: string;
  markdownTruncated: boolean;
  elements: InteractiveElement[];
  elementsTruncated: boolean;
}

export interface OpenSessionOptions {
  timeoutMs?: number;
  settleMs?: number;
  signal?: AbortSignal;
}

export interface ActionOptions {
  signal?: AbortSignal;
}

// ─── Page-side scripts (executed in the loaded page's main world) ────

/**
 * Returns the raw DOM info for the page. The Node-side caller post-
 * processes (markdown extraction, capping, etc.).
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const REF_ATTR = 'data-aix-ref';
  const sel = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
  const nodes = document.querySelectorAll(sel);
  let next = 0;
  for (const el of nodes) {
    if (!el.getAttribute(REF_ATTR)) {
      next += 1;
      el.setAttribute(REF_ATTR, 'r' + next);
    }
  }
  const out = [];
  const all = document.querySelectorAll('[' + REF_ATTR + ']');
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0
      && rect.bottom > -200 && rect.top < (window.innerHeight + 200);
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const role = el.getAttribute('role') || undefined;
    const type = el.getAttribute('type') || undefined;
    const placeholder = el.getAttribute('placeholder') || undefined;
    const href = el.getAttribute('href') || undefined;
    let value;
    if ('value' in el && typeof el.value === 'string') {
      value = el.value.length > 200 ? el.value.slice(0, 200) : el.value;
    }
    out.push({
      ref: el.getAttribute(REF_ATTR),
      tag: el.tagName.toLowerCase(),
      role,
      type,
      text: text || undefined,
      placeholder,
      value,
      href,
      visible,
    });
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
    html: document.documentElement.outerHTML,
  };
})()`;

/**
 * Click an element by ref. Args spliced via JSON.stringify so the ref
 * cannot break out of the string literal.
 */
export const buildClickScript = (ref: string): string =>
  `(() => {
    const REF = ${JSON.stringify(ref)};
    const el = document.querySelector('[data-aix-ref="' + REF + '"]');
    if (!el) return { error: 'ref-not-found', ref: REF };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    el.focus?.();
    el.click();
    return { ok: true };
  })()`;

/**
 * Type into an input/textarea/contenteditable by ref. Uses the native
 * value setter to bypass React's value-tracking guard so framework-
 * controlled inputs accept programmatic changes.
 */
export const buildTypeScript = (
  ref: string,
  text: string,
  submit: boolean,
): string =>
  `(() => {
    const REF = ${JSON.stringify(ref)};
    const TEXT = ${JSON.stringify(text)};
    const SUBMIT = ${submit ? "true" : "false"};
    const el = document.querySelector('[data-aix-ref="' + REF + '"]');
    if (!el) return { error: 'ref-not-found', ref: REF };
    el.focus?.();
    if (el.isContentEditable) {
      el.textContent = TEXT;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const proto = Object.getPrototypeOf(el);
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, TEXT);
      } else {
        el.value = TEXT;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (SUBMIT) {
      const form = el.form;
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
    }
    return { ok: true };
  })()`;

// ─── Snapshot post-processing ────────────────────────────────────────

interface RawPageInfo {
  url: string;
  title: string;
  elements: InteractiveElement[];
  html: string;
}

/**
 * Convert raw page info into a token-efficient snapshot. Exported for
 * unit tests (the cap logic, not the Electron path).
 */
export const buildSnapshotFromRaw = (
  raw: RawPageInfo,
  sessionId: string,
): InteractiveSnapshot => {
  const readable = extractReadable(raw.html, raw.url);
  const md = readable.markdown ?? "";
  const markdownTruncated = md.length > MARKDOWN_CAP_BYTES;
  const markdown = markdownTruncated ? md.slice(0, MARKDOWN_CAP_BYTES) : md;

  const visible = raw.elements.filter((e) => e.visible);
  const invisible = raw.elements.filter((e) => !e.visible);
  const elements: InteractiveElement[] = [];
  for (const e of visible) {
    if (elements.length >= MAX_ELEMENTS_PER_SNAPSHOT) break;
    elements.push(e);
  }
  for (const e of invisible) {
    if (elements.length >= MAX_ELEMENTS_PER_SNAPSHOT) break;
    elements.push(e);
  }
  const elementsTruncated = raw.elements.length > MAX_ELEMENTS_PER_SNAPSHOT;

  return {
    sessionId,
    url: raw.url,
    title: raw.title || readable.title || "",
    markdown,
    markdownTruncated,
    elements,
    elementsTruncated,
  };
};

// ─── Session state ───────────────────────────────────────────────────

interface Session {
  id: string;
  window: BrowserWindow;
  partition: string;
  lastUsedAt: number;
  createdAt: number;
}

const sessions = new Map<string, Session>();
let reaperTimer: NodeJS.Timeout | null = null;
let appQuitHookInstalled = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

const touch = (s: Session): void => {
  s.lastUsedAt = Date.now();
};

const closeWindow = async (s: Session): Promise<void> => {
  try {
    if (!s.window.isDestroyed()) s.window.close();
  } catch {
    // already closed
  }
  try {
    await session.fromPartition(s.partition).clearStorageData();
  } catch {
    // partition may never have been touched
  }
};

const evictOne = async (): Promise<void> => {
  let oldest: Session | null = null;
  for (const s of sessions.values()) {
    if (!oldest || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
  }
  if (oldest) {
    sessions.delete(oldest.id);
    await closeWindow(oldest);
  }
};

const ensureReaper = (): void => {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    const stale: Session[] = [];
    for (const s of sessions.values()) {
      if (now - s.lastUsedAt > IDLE_TIMEOUT_MS) stale.push(s);
    }
    for (const s of stale) {
      sessions.delete(s.id);
      void closeWindow(s);
    }
    if (sessions.size === 0 && reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
  }, REAPER_INTERVAL_MS);
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
};

const ensureAppQuitHook = (): void => {
  if (appQuitHookInstalled) return;
  try {
    app.on("before-quit", () => {
      for (const s of sessions.values()) void closeWindow(s);
      sessions.clear();
      if (reaperTimer) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }
    });
    appQuitHookInstalled = true;
  } catch {
    // `app` may not be ready in some unit-test contexts; the reaper
    // still handles long-lived cleanup, so failing to install the
    // quit hook is non-fatal.
  }
};

// ─── Internals ───────────────────────────────────────────────────────

const waitForLoad = (
  win: BrowserWindow,
  timeoutMs: number,
): Promise<number | null> =>
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
    const cleanup = (): void => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
    };
    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
  });

const takeSnapshot = async (s: Session): Promise<InteractiveSnapshot> => {
  const raw = (await s.window.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT,
  )) as RawPageInfo;
  return buildSnapshotFromRaw(raw, s.id);
};

const requireSession = (sessionId: string): Session => {
  const s = sessions.get(sessionId);
  if (!s) {
    throw new Error(
      `browser session ${sessionId} not found (expired or never opened)`,
    );
  }
  touch(s);
  return s;
};

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Open a fresh browser session. Loads `url`, waits for hydration,
 * returns a snapshot keyed by a new sessionId. Subsequent
 * click/type/snapshot calls must pass this id.
 */
export const openBrowserSession = async (
  url: string,
  opts: OpenSessionOptions = {},
): Promise<InteractiveSnapshot> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;

  if (opts.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  ensureAppQuitHook();
  ensureReaper();

  while (sessions.size >= MAX_SESSIONS) {
    await evictOne();
  }

  const id = randomUUID();
  const partition = `headless-session-${id}`;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const onAbort = (): void => {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      // ignore
    }
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const loadPromise = waitForLoad(win, timeoutMs);
    void win.webContents.loadURL(url);
    await loadPromise;
    await sleep(settleMs);

    const s: Session = {
      id,
      window: win,
      partition,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
    };
    sessions.set(id, s);
    return await takeSnapshot(s);
  } catch (err) {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      // ignore
    }
    try {
      await session.fromPartition(partition).clearStorageData();
    } catch {
      // ignore
    }
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Click the element identified by `ref` on the current page of
 * `sessionId`. If the click triggers navigation, waits for the new
 * page to load (soft timeout) before snapshotting.
 */
export const clickInBrowserSession = async (
  sessionId: string,
  ref: string,
  _opts: ActionOptions = {},
): Promise<InteractiveSnapshot> => {
  const s = requireSession(sessionId);
  const wc = s.window.webContents;

  let navStarted = false;
  const onNav = (): void => {
    navStarted = true;
  };
  wc.once("did-start-navigation", onNav);

  let actionResult: { ok?: true; error?: string };
  try {
    actionResult = (await wc.executeJavaScript(buildClickScript(ref))) as {
      ok?: true;
      error?: string;
    };
  } catch (err) {
    wc.removeListener("did-start-navigation", onNav);
    throw err;
  }

  if (actionResult?.error) {
    wc.removeListener("did-start-navigation", onNav);
    throw new Error(`click failed: ${actionResult.error} (ref=${ref})`);
  }

  await sleep(POST_ACTION_SETTLE_MS);

  if (navStarted) {
    try {
      await waitForLoad(s.window, NAV_WAIT_TIMEOUT_MS);
    } catch {
      // Soft-fail: snapshot whatever loaded.
    }
    await sleep(POST_NAV_SETTLE_MS);
  } else {
    wc.removeListener("did-start-navigation", onNav);
  }

  return await takeSnapshot(s);
};

/**
 * Type `text` into the element identified by `ref`. When `submit` is
 * true, also dispatches Enter / form submit after the value lands and
 * waits for navigation.
 */
export const typeInBrowserSession = async (
  sessionId: string,
  ref: string,
  text: string,
  submit: boolean,
  _opts: ActionOptions = {},
): Promise<InteractiveSnapshot> => {
  const s = requireSession(sessionId);
  const wc = s.window.webContents;

  let navStarted = false;
  const onNav = (): void => {
    navStarted = true;
  };
  if (submit) wc.once("did-start-navigation", onNav);

  let actionResult: { ok?: true; error?: string };
  try {
    actionResult = (await wc.executeJavaScript(
      buildTypeScript(ref, text, submit),
    )) as { ok?: true; error?: string };
  } catch (err) {
    if (submit) wc.removeListener("did-start-navigation", onNav);
    throw err;
  }

  if (actionResult?.error) {
    if (submit) wc.removeListener("did-start-navigation", onNav);
    throw new Error(`type failed: ${actionResult.error} (ref=${ref})`);
  }

  await sleep(POST_ACTION_SETTLE_MS);

  if (submit && navStarted) {
    try {
      await waitForLoad(s.window, NAV_WAIT_TIMEOUT_MS);
    } catch {
      // Soft-fail: snapshot whatever loaded.
    }
    await sleep(POST_NAV_SETTLE_MS);
  } else if (submit) {
    wc.removeListener("did-start-navigation", onNav);
  }

  return await takeSnapshot(s);
};

/** Re-read the current page without acting. */
export const snapshotBrowserSession = async (
  sessionId: string,
): Promise<InteractiveSnapshot> => {
  const s = requireSession(sessionId);
  return await takeSnapshot(s);
};

/** Close and discard a session. No-op when the id is unknown. */
export const closeBrowserSession = async (
  sessionId: string,
): Promise<{ closed: boolean }> => {
  const s = sessions.get(sessionId);
  if (!s) return { closed: false };
  sessions.delete(s.id);
  await closeWindow(s);
  return { closed: true };
};

/** Test hook — clears all sessions without touching real windows. */
export const _resetForTests = (): void => {
  for (const s of sessions.values()) {
    try {
      if (!s.window.isDestroyed?.()) s.window.close?.();
    } catch {
      // ignore
    }
  }
  sessions.clear();
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
};
