/**
 * hidden-browser —在沙箱化的隐藏 Electron BrowserWindow 中加载 URL
 * 并返回渲染后的 HTML。用于驱动 `webFetchRendered` agent 工具
 *（web-access 栈的第 2' 层）。
 *
 * 为何用 Electron 而非 Playwright: 应用本身已内置 Chromium;派生隐藏
 * 窗口可直接复用它（零包体增量,真实的 Chrome 指纹,比合成的
 * headless UA 更易被反爬规则接受）。代价: 可调项比 Playwright 少 ——
 * 没有丰富的 `evaluate(fn)` 体验,也没有内置 stealth —— 但对于"加载
 * 页面、等其水合、抓取 outerHTML"这类需求已足够。
 *
 * 隔离: 每次加载使用 `headless-<uuid>` 会话分区,使 cookie/localStorage
 * 绝不会渗入用户的主会话。`contextIsolation`、`sandbox`、无 preload
 * → 被加载页面无法触及 Node。
 *
 * 并发: 限制为最多 2 个并行渲染,使 agent 无法 fork 出 50 个 fetch
 * 而撑爆内存。有状态的交互式会话位于 `interactive-browser.ts`;窗口
 * 创建 + 销毁原语通过 `browser-window-utils.ts` 共享。
 */
import { randomUUID } from "node:crypto";

import type { BrowserWindow } from "electron";

import { assertAgentBrowserUrl } from "../browser/security-policy";
import {
  createHiddenWindow,
  destroyHiddenWindow,
  sleep,
  waitForPageLoad,
} from "./browser-window-utils";

export interface RenderedFetchResult {
  html: string;
  finalUrl: string;
  /** 来自 `did-finish-load` 的尽力而为的 HTTP 状态码。加载失败时为 null。 */
  status: number | null;
}

interface RenderOpts {
  /** `loadURL` 的硬超时。默认 15s。 */
  timeoutMs?: number;
  /** did-finish-load 之后用于 SPA 水合的静默延迟。默认 1500ms。 */
  settleMs?: number;
  /**
   * 可选的取消信号。在排队期间（不派生窗口即 reject）和加载期间
   *（waitForPageLoad 直接监听该信号）均会被遵守。
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
  const target = assertAgentBrowserUrl(url);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const settleMs = opts.settleMs ?? 1_500;

  await acquire(opts.signal);
  const partition = `headless-${randomUUID()}`;
  let win: BrowserWindow | null = null;
  try {
    win = createHiddenWindow(partition);
    const wc = win.webContents;
    const loadPromise = waitForPageLoad(win, timeoutMs, opts.signal);
    void wc.loadURL(target.href);
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
