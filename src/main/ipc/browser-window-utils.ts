/**
 * 隐藏 Electron `BrowserWindow` 使用的共享原语。
 *
 * 目前有两个使用方:`hidden-browser.ts`(为 `webFetchRendered` 做的
 * 无状态一次性渲染)与 `interactive-browser.ts`(为
 * `browserOpen`/`browserClick`/`browserType`/... 提供的有状态会话)。
 * 两者都需要相同的沙箱配置、相同的 `did-finish-load` /
 * `did-fail-load` 竞态处理,以及相同的关闭 + 清理分区的拆解流程。
 *
 * 此处的窗口选项必须在各使用方之间保持一致 —— 它们定义了安全边界
 * (无 Node 访问、隔离分区)。
 */
import { BrowserWindow, session } from "electron";

/** 应用中每个隐藏窗口共享的沙箱 webPreferences。 */
export const HIDDEN_WINDOW_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} as const;

/**
 * 创建一个绑定到给定会话分区的隐藏、沙箱化 BrowserWindow。该窗口无
 * preload、无 Node 集成、存储隔离 —— 可安全指向任意第三方 URL。
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
 * 等待给定的 `webContents` 完成加载,带有硬超时和可选的中止。在
 * `did-finish-load` 时以 `200` resolve,在 `did-fail-load`、超时或信号
 * 中止时 reject。
 *
 * 调用方负责发起加载(例如通过 `loadURL`)。此辅助函数仅做监听。
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
 * 关闭窗口(若仍存活)并清理其会话分区。两步均为尽力而为并吞掉
 * 错误 —— 走到这里时我们已处于拆解阶段,因此任何失败(窗口已被
 * 销毁、分区从未被触及)都不致命。
 */
export const destroyHiddenWindow = async (
  win: BrowserWindow | null,
  partition: string,
): Promise<void> => {
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
    /* 吞掉 */
  }
  try {
    await session.fromPartition(partition).clearStorageData();
  } catch {
    /* 吞掉 */
  }
};

/** `await sleep(ms)` —— 对 Promise 友好的 setTimeout。 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
