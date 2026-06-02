/**
 * interactive-browser —在隐藏的 Electron BrowserWindow 之上的有状态
 * 浏览会话。用于驱动 `browserOpen / browserClick / browserType /
 * browserSnapshot / browserClose` agent 工具,弥补 GAIA 式的交互式
 * 浏览缺口（无状态的 `webFetchRendered` 只渲染一次便丢弃状态）。
 *
 * 模型:
 *   - `openBrowserSession(url)` 派生一个隐藏的、沙箱化的 BrowserWindow,
 *     拥有自己的 `headless-session-<uuid>` 分区（cookie/localStorage
 *     与用户主会话隔离,在会话内持久）。
 *   - 每次交互调用（click/type）以 session id 和逐页面的 `ref` id
 *     （自动赋给交互元素的 `data-aix-ref` 属性）为键,而非 CSS 选择器。
 *     相比裸选择器,这大幅降低了 LLM 的脆弱性。
 *   - 每次动作后返回紧凑快照: 页面 URL/标题 + 阅读模式 markdown +
 *     带 ref 的可见交互元素列表。
 *
 * 生命周期:
 *   - 同时最多存活 {@link MAX_SESSIONS} 个;打开超出上限时淘汰最久
 *     未使用的会话。槽位预留通过 `openSlotChain` 串行化,使并发打开
 *     不会各自淘汰一个健康会话。
 *   - 空闲回收器会关闭超过 {@link IDLE_TIMEOUT_MS} 未被触碰的会话。
 *     该定时器一旦启动便永久运行（已 `.unref()`）,因此"数量归零、
 *     清除定时器"与"新会话到来"之间不存在竞态。
 *   - 会话在 `app:before-quit` 时清理,以避免泄漏窗口。
 *
 * 安全:
 *   - 所有页面侧脚本在拼接进 JS 源码之前,都会先将 LLM 提供的值经
 *     `JSON.stringify` 处理,因此恶意的 `ref` 或 `text` 无法逃逸字符串
 *     字面量。
 *   - `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
 *     意味着被加载页面无法触及 Node API。
 *
 * 窗口创建、load 事件竞态,以及分区销毁通过 `browser-window-utils.ts`
 * 与 `hidden-browser.ts` 共享。
 */
import { randomUUID } from "node:crypto";

import { app, type BrowserWindow } from "electron";

import { extractReadable } from "../core/agent/tools/web-extract";
import {
  createHiddenWindow,
  destroyHiddenWindow,
  sleep,
  waitForPageLoad,
} from "./browser-window-utils";

// ─── 限制 ──────────────────────────────────────────────────────────

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

// ─── 类型 ───────────────────────────────────────────────────────────

export interface InteractiveElement {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  /** 可见文本（innerText）,截断至约 80 字符。 */
  text?: string;
  placeholder?: string;
  /** 当前输入值,已截断。 */
  value?: string;
  href?: string;
  /** 至少部分位于视口内时为 true。 */
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

// ─── 页面侧脚本（在被加载页面的 main world 中执行）────

/**
 * 返回页面的原始 DOM 信息。由 Node 侧调用方进行后处理（markdown
 * 提取、上限截断等）。
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
 * 按 ref 点击一个元素。参数经 JSON.stringify 拼接,使 ref 无法逃逸
 * 字符串字面量。
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
 * 按 ref 向 input/textarea/contenteditable 输入文本。使用原生 value
 * setter 以绕过 React 的 value-tracking 守卫,使受框架控制的输入接受
 * 编程式更改。
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

// ─── 快照后处理 ────────────────────────────────────────

interface RawPageInfo {
  url: string;
  title: string;
  elements: InteractiveElement[];
  html: string;
}

/**
 * 将原始页面信息转换为节省 token 的快照。导出供单元测试使用（针对
 * 上限截断逻辑,而非 Electron 路径）。
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

// ─── 会话状态 ───────────────────────────────────────────────────

interface Session {
  id: string;
  window: BrowserWindow;
  partition: string;
  lastUsedAt: number;
}

const sessions = new Map<string, Session>();
let reaperTimer: NodeJS.Timeout | null = null;
let appQuitHookInstalled = false;

/**
 * 串行化 `openBrowserSession` 的槽位预留阶段。每个调用方在检查上限
 * 之前先等待上一个调用方的预留（淘汰 + 窗口创建 + map 插入）完成,
 * 然后释放 —— 这使得耗时的 loadURL 可以在多次打开之间并行运行。
 */
let openSlotChain: Promise<void> = Promise.resolve();

const touch = (s: Session): void => {
  s.lastUsedAt = Date.now();
};

const evictOne = async (): Promise<void> => {
  let oldest: Session | null = null;
  for (const s of sessions.values()) {
    if (!oldest || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
  }
  if (oldest) {
    sessions.delete(oldest.id);
    await destroyHiddenWindow(oldest.window, oldest.partition);
  }
};

const ensureReaper = (): void => {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (now - s.lastUsedAt > IDLE_TIMEOUT_MS) {
        sessions.delete(s.id);
        void destroyHiddenWindow(s.window, s.partition);
      }
    }
  }, REAPER_INTERVAL_MS);
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
};

const ensureAppQuitHook = (): void => {
  if (appQuitHookInstalled) return;
  try {
    app.on("before-quit", () => {
      for (const s of sessions.values()) {
        void destroyHiddenWindow(s.window, s.partition);
      }
      sessions.clear();
      if (reaperTimer) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }
    });
    appQuitHookInstalled = true;
  } catch {
    // 在某些单元测试上下文中 `app` 可能尚未就绪;回收器仍会处理
    // 长生命周期的清理,因此安装 quit 钩子失败并非致命问题。
  }
};

// ─── 内部实现 ───────────────────────────────────────────────────────

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

/**
 * 在 `openSlotChain` 互斥锁下于 LRU 中预留一个槽位,然后同步创建
 * 窗口并将会话提交到 `sessions` map。返回前释放该链,使调用方可将
 * 其耗时的 loadURL 与其他打开操作并行执行。
 */
const reserveSlotAndCreateSession = async (
  opts: OpenSessionOptions,
): Promise<Session> => {
  const prev = openSlotChain;
  let releaseSlot!: () => void;
  openSlotChain = new Promise<void>((r) => {
    releaseSlot = r;
  });
  try {
    await prev;
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
    const win = createHiddenWindow(partition);
    const s: Session = {
      id,
      window: win,
      partition,
      lastUsedAt: Date.now(),
    };
    sessions.set(id, s);
    return s;
  } finally {
    releaseSlot();
  }
};

/**
 * 运行一个页面侧动作脚本,可选地等待导航完成,然后对结果页面
 * 拍快照。集中处理 click 与 type 共享的监听器管理流程。
 */
const runActionWithNavWait = async (
  s: Session,
  script: string,
  errPrefix: string,
  opts: ActionOptions,
): Promise<InteractiveSnapshot> => {
  const wc = s.window.webContents;
  let navStarted = false;
  const onNav = (): void => {
    navStarted = true;
  };
  wc.once("did-start-navigation", onNav);

  try {
    const result = (await wc.executeJavaScript(script)) as {
      ok?: true;
      error?: string;
    };
    if (result?.error) {
      throw new Error(`${errPrefix}: ${result.error}`);
    }

    await sleep(POST_ACTION_SETTLE_MS);

    if (navStarted) {
      try {
        await waitForPageLoad(s.window, NAV_WAIT_TIMEOUT_MS, opts.signal);
      } catch {
        // 软失败: 无论加载到什么,都对其拍快照。
      }
      await sleep(POST_NAV_SETTLE_MS);
    }
  } finally {
    // `wc.once` 在触发时自动移除;仅在它从未触发（无导航）时才手动
    // 移除,以避免遗留悬挂的监听器。
    if (!navStarted) wc.removeListener("did-start-navigation", onNav);
  }

  return await takeSnapshot(s);
};

// ─── 公共 API ──────────────────────────────────────────────────────

/**
 * 打开一个全新的浏览会话。加载 `url`,等待水合,返回以新 sessionId
 * 为键的快照。后续的 click/type/snapshot 调用必须传入此 id。
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

  const s = await reserveSlotAndCreateSession(opts);

  // 耗时加载在槽位互斥锁释放后运行 —— 并发打开可以让各自的网络 IO
  // 互相重叠。
  try {
    const loadPromise = waitForPageLoad(s.window, timeoutMs, opts.signal);
    void s.window.webContents.loadURL(url);
    await loadPromise;
    await sleep(settleMs);
    return await takeSnapshot(s);
  } catch (err) {
    sessions.delete(s.id);
    await destroyHiddenWindow(s.window, s.partition);
    throw err;
  }
};

/**
 * 点击 `sessionId` 当前页面上由 `ref` 标识的元素。若点击触发导航,
 * 则在拍快照前等待新页面加载完成（软超时）。
 */
export const clickInBrowserSession = async (
  sessionId: string,
  ref: string,
  opts: ActionOptions = {},
): Promise<InteractiveSnapshot> => {
  const s = requireSession(sessionId);
  return await runActionWithNavWait(
    s,
    buildClickScript(ref),
    `click failed (ref=${ref})`,
    opts,
  );
};

/**
 * 向由 `ref` 标识的元素输入 `text`。当 `submit` 为 true 时,在值落定
 * 后还会派发 Enter / 表单提交,并等待导航完成。
 */
export const typeInBrowserSession = async (
  sessionId: string,
  ref: string,
  text: string,
  submit: boolean,
  opts: ActionOptions = {},
): Promise<InteractiveSnapshot> => {
  const s = requireSession(sessionId);
  return await runActionWithNavWait(
    s,
    buildTypeScript(ref, text, submit),
    `type failed (ref=${ref})`,
    opts,
  );
};

/** 不执行任何动作,重新读取当前页面。 */
export const snapshotBrowserSession = async (
  sessionId: string,
): Promise<InteractiveSnapshot> => {
  const s = requireSession(sessionId);
  return await takeSnapshot(s);
};

/** 关闭并丢弃一个会话。当 id 未知时为空操作。 */
export const closeBrowserSession = async (
  sessionId: string,
): Promise<{ closed: boolean }> => {
  const s = sessions.get(sessionId);
  if (!s) return { closed: false };
  sessions.delete(s.id);
  await destroyHiddenWindow(s.window, s.partition);
  return { closed: true };
};
