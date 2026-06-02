import type { WebviewTag } from "electron";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";

interface BrowserPanelProps {
  /** 初始 URL。后续 prop 变化仅在新 URL 与 webview 当前位置
   *  不同时才加载 —— 内部导航
   *  (前进/后退、页面内的链接点击)不会被覆盖。 */
  url: string;
}

// Vite 在渲染进程构建时内联 process.env.NODE_ENV。
const WEBVIEW_PARTITION =
  process.env.NODE_ENV === "production"
    ? "persist:in-app-browser"
    : "in-app-browser";

/** 对应 BranchDiffPanel —— 位于 App 的 flex 行中,而非模态框。 */
export function BrowserPanel({ url }: BrowserPanelProps) {
  const { LL } = useI18nContext();
  const webviewRef = useRef<WebviewTag | null>(null);

  // 为 webview 的 `src` 属性快照最初的 URL。
  // 后续 prop 变化都经由命令式的 loadURL effect ——
  // 而非通过 React 更新 src —— 以避免 Chromium webview 的
  // 双重加载(src 属性变化触发一次导航 + loadURL 触发一次)。
  const initialUrlRef = useRef(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  // 将 currentUrl 镜像到 ref,使 prop 变化的 effect 可以比较
  // 而无需在每次内部导航时重新执行。
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const [draftUrl, setDraftUrl] = useState(url);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // 一旦 webview 触发 dom-ready 即为 true。在此之前调用 loadURL
  // 会在 Electron 的 webview 实现内部抛错;在此排队记录意图,
  // 并在 dom-ready 时刷出。
  const [domReady, setDomReady] = useState(false);
  const pendingLoadRef = useRef<string | null>(null);

  // 跟踪我们已附加的监听器,以便 ref 回调在 webview 元素变化时
  // (StrictMode 挂载周期、key 变化等)能干净地解绑。
  // 否则监听器只会在首次挂载时绑定一次,
  // 永远不会重新附加到新元素上。
  const attachedRef = useRef<{
    wv: WebviewTag;
    handlers: Record<string, (e: Event) => void>;
  } | null>(null);

  const attachListeners = useCallback((wv: WebviewTag) => {
    const refreshNavState = () => {
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
      } catch {
        // webview 尚未附加
      }
    };

    const handlers: Record<string, (e: Event) => void> = {
      "dom-ready": () => {
        setDomReady(true);
        refreshNavState();
        const pending = pendingLoadRef.current;
        pendingLoadRef.current = null;
        if (pending) {
          wv.loadURL(pending).catch((err) => {
            console.warn("[BrowserPanel] pending loadURL failed:", err);
            setFailure(String(err?.message ?? err));
          });
        }
      },
      "did-start-loading": () => {
        setLoading(true);
        setFailure(null);
      },
      "did-stop-loading": () => {
        setLoading(false);
        refreshNavState();
      },
      // 完整的顶层导航:同时刷新 currentUrl 和地址栏的
      // 草稿值(用户此时不在编辑中,因为焦点在
      // 页面里而非地址栏)。
      "did-navigate": (e) => {
        const navUrl = (e as Event & { url: string }).url;
        if (navUrl) {
          setCurrentUrl(navUrl);
          setDraftUrl(navUrl);
        }
        refreshNavState();
      },
      // 页面内导航(hash / SPA 路由):更新 currentUrl 作为
      // "在系统浏览器打开"的目标,但不要触碰地址栏草稿值 ——
      // 用户可能正在输入。
      "did-navigate-in-page": (e) => {
        const navUrl = (e as Event & { url: string }).url;
        if (navUrl) setCurrentUrl(navUrl);
        refreshNavState();
      },
      "did-fail-load": (e) => {
        const evt = e as Event & {
          errorCode: number;
          errorDescription: string;
          isMainFrame: boolean;
        };
        if (!evt.isMainFrame) return;
        if (evt.errorCode === -3) return; // ERR_ABORTED
        setLoading(false);
        setFailure(evt.errorDescription || `Error ${evt.errorCode}`);
      },
      "new-window": (e) => {
        e.preventDefault();
        const newUrl = (e as Event & { url: string }).url;
        if (newUrl) wv.loadURL(newUrl).catch(() => {});
      },
    };
    for (const [evt, fn] of Object.entries(handlers)) {
      wv.addEventListener(evt, fn);
    }
    attachedRef.current = { wv, handlers };
  }, []);

  const detachListeners = useCallback(() => {
    const prev = attachedRef.current;
    if (!prev) return;
    for (const [evt, fn] of Object.entries(prev.handlers)) {
      try {
        prev.wv.removeEventListener(evt, fn);
      } catch {
        // element already torn down
      }
    }
    attachedRef.current = null;
  }, []);

  // Ref callback fires every time the webview element changes (mount,
  // StrictMode remount, key change). Detach from the previous element,
  // attach to the new one. Avoids stale-listener bugs from useEffect
  // with `[]` deps.
  const setWebviewRef = useCallback(
    (el: HTMLElement | null) => {
      const next = el as unknown as WebviewTag | null;
      if (attachedRef.current?.wv === next) return;
      detachListeners();
      webviewRef.current = next;
      if (next) {
        // Reset readiness flags whenever a new element appears.
        setDomReady(false);
        attachListeners(next);
      }
    },
    [attachListeners, detachListeners],
  );

  // Unmount cleanup.
  useEffect(() => detachListeners, [detachListeners]);

  // When the parent passes a new URL (user clicked a different link in
  // chat), load it imperatively. Queue if the webview hasn't fired
  // dom-ready yet — loadURL before dom-ready throws.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (url === currentUrlRef.current) return;
    if (!domReady) {
      pendingLoadRef.current = url;
      return;
    }
    wv.loadURL(url).catch((err) => {
      console.warn("[BrowserPanel] loadURL failed:", err);
      setFailure(String(err?.message ?? err));
    });
  }, [url, domReady]);

  // ---- toolbar handlers ----------------------------------------------------
  const handleBack = () => webviewRef.current?.goBack();
  const handleForward = () => webviewRef.current?.goForward();
  const handleReloadOrStop = () => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (loading) wv.stop();
    else wv.reload();
  };
  const handleOpenExternal = () => {
    if (!currentUrl) return;
    window.filework.openExternal(currentUrl).catch((err) => {
      console.warn("[BrowserPanel] openExternal failed:", err);
      setFailure(String(err?.message ?? err));
    });
  };
  const handleSubmitUrl = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const wv = webviewRef.current;
    if (!wv) return;
    const target = normalizeUrl(draftUrl);
    if (!target) return;
    wv.loadURL(target).catch(() => {});
  };

  return (
    <aside className="flex h-full w-full flex-col bg-background">
      <header className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
        <button
          type="button"
          onClick={handleBack}
          disabled={!canGoBack}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title={LL.browser_back()}
          aria-label={LL.browser_back()}
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={handleForward}
          disabled={!canGoForward}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          title={LL.browser_forward()}
          aria-label={LL.browser_forward()}
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={handleReloadOrStop}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          title={loading ? LL.browser_stop() : LL.browser_reload()}
          aria-label={loading ? LL.browser_stop() : LL.browser_reload()}
        >
          {loading ? (
            <X className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
        <form onSubmit={handleSubmitUrl} className="flex-1 min-w-0">
          <input
            type="text"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder={LL.browser_url_placeholder()}
            spellCheck={false}
            className="w-full px-2 py-1 text-xs font-mono rounded bg-muted/40 border border-transparent focus:outline-none focus:border-border focus:bg-background"
          />
        </form>
        <button
          type="button"
          onClick={handleOpenExternal}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          title={LL.browser_open_external()}
          aria-label={LL.browser_open_external()}
        >
          <ExternalLink className="size-3.5" />
        </button>
      </header>

      <div className="relative flex-1 min-h-0">
        <webview
          ref={setWebviewRef}
          // Static src: only the initial load uses this; subsequent
          // navigations go through the imperative loadURL effect.
          src={initialUrlRef.current}
          // Persistent partition in production for site logins / cookies.
          // In dev (no CSP applied to the host renderer), use an in-memory
          // partition so any test page can't drop persistent state that
          // affects future sessions.
          partition={WEBVIEW_PARTITION}
          allowpopups={true}
          className={cn("absolute inset-0 w-full h-full", failure && "hidden")}
        />
        {failure && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center bg-background">
            <div className="text-xs text-destructive">
              {LL.browser_failed_to_load()}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground break-all max-w-full">
              {failure}
            </div>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent"
            >
              <ExternalLink className="size-3" />
              {LL.browser_open_external()}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

// File extensions that look like TLDs would otherwise match the bare-
// domain regex below and be wrapped as `https://file.ext`. Reject
// them so `package.json` doesn't become `https://package.json`.
const FILE_EXTENSIONS = new Set([
  "json",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "md",
  "txt",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "yaml",
  "yml",
  "toml",
  "ini",
  "lock",
  "log",
  "env",
  "sh",
  "zsh",
  "bash",
  "sql",
  "xml",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "zip",
  "tar",
  "gz",
]);

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare domain: must look like host[.tld]+, optionally followed by
  // path / query / fragment. Reject trailing-label file extensions.
  const match = trimmed.match(/^([\w-]+(?:\.[\w-]+)+)(?:[/?#]|$)/);
  if (!match) return null;
  const host = match[1];
  if (host.startsWith(".") || host.endsWith(".") || host.includes(".."))
    return null;
  const lastLabel = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
  if (FILE_EXTENSIONS.has(lastLabel)) return null;
  return `https://${trimmed}`;
}
