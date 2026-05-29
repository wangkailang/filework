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
  /** Initial URL. Subsequent prop changes load the new URL only if it
   *  differs from the webview's current location — internal navigation
   *  (back/forward, link clicks inside the page) is not clobbered. */
  url: string;
}

// Vite inlines process.env.NODE_ENV at build time in the renderer.
const WEBVIEW_PARTITION =
  process.env.NODE_ENV === "production"
    ? "persist:in-app-browser"
    : "in-app-browser";

/** Mirror BranchDiffPanel — sits in the App flex row, not a modal. */
export function BrowserPanel({ url }: BrowserPanelProps) {
  const { LL } = useI18nContext();
  const webviewRef = useRef<WebviewTag | null>(null);

  // Snapshot the very first URL for the webview's `src` attribute.
  // Subsequent prop changes route through the imperative loadURL effect
  // — never through React updating src — to avoid Chromium's webview
  // double-loading (one nav from src attr change + one from loadURL).
  const initialUrlRef = useRef(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  // Mirror of currentUrl into a ref so the prop-change effect can compare
  // without re-running on every internal navigation.
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const [draftUrl, setDraftUrl] = useState(url);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // True once the webview has fired dom-ready. loadURL before this
  // point throws inside Electron's webview impl; queue intent here and
  // flush on dom-ready.
  const [domReady, setDomReady] = useState(false);
  const pendingLoadRef = useRef<string | null>(null);

  // Tracks listeners we've attached so the ref-callback can detach them
  // cleanly when the webview element changes (StrictMode mount cycle,
  // key changes, etc.). Without this, listeners bind once at first
  // mount and never re-attach to the new element.
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
        // webview not yet attached
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
      // Full top-level navigation: refresh both currentUrl and the URL
      // bar's draft value (user is not mid-edit because focus is in
      // the page, not the address bar).
      "did-navigate": (e) => {
        const navUrl = (e as Event & { url: string }).url;
        if (navUrl) {
          setCurrentUrl(navUrl);
          setDraftUrl(navUrl);
        }
        refreshNavState();
      },
      // In-page nav (hash / SPA route): update currentUrl for the
      // "open in system browser" target, but DON'T touch the draft URL
      // bar — the user may be typing.
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
