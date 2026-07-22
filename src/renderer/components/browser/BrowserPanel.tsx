import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { useI18nContext } from "../../i18n/i18n-react";
import { BrowserTabStrip } from "./BrowserTabStrip";
import { BrowserViewport } from "./BrowserViewport";
import { useBrowserTabs } from "./useBrowserTabs";

interface BrowserPanelProps {
  url: string;
  active?: boolean;
}

const isBlank = (url: string): boolean => !url || url === "about:blank";
const isLocalFileUrl = (url: string): boolean =>
  url.startsWith("local-file://");

const localFilePath = (url: string): string => {
  try {
    return new URL(url).searchParams.get("path") || url;
  } catch {
    return url;
  }
};

const localFileLabel = (url: string): string => {
  const path = localFilePath(url);
  return path.split("/").pop() || path;
};

export function BrowserPanel({ url, active = true }: BrowserPanelProps) {
  const { LL } = useI18nContext();
  const browser = useBrowserTabs();
  const current = browser.activeTab;
  const [draftUrl, setDraftUrl] = useState(url || current?.url || "");
  const creatingBlankRef = useRef(false);
  const requestedUrlRef = useRef<string | null>(null);
  const currentUrl = current?.url ?? "";
  const isLocalCurrent = isLocalFileUrl(currentUrl);
  const showStart = !current || isBlank(currentUrl);
  const showCrash = current?.crashed === true;

  useEffect(() => {
    if (!browser.ready) return;
    if (url) {
      if (requestedUrlRef.current === url) return;
      requestedUrlRef.current = url;
      void browser.openUrl(url).catch(() => undefined);
      return;
    }
    if (browser.tabs.length === 0 && !creatingBlankRef.current) {
      creatingBlankRef.current = true;
      void browser
        .createTab({ kind: "web" })
        .catch(() => undefined)
        .finally(() => {
          creatingBlankRef.current = false;
        });
    }
  }, [browser, url]);

  useEffect(() => {
    setDraftUrl(currentUrl);
  }, [currentUrl]);

  const handleSubmitUrl = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || isLocalCurrent) return;
    const target = normalizeBrowserInput(draftUrl);
    if (target)
      void browser.navigate(current.id, target).catch(() => undefined);
  };

  const handleReloadOrStop = () => {
    if (!current) return;
    void browser
      .command(current.id, current.loading ? "stop" : "reload")
      .catch(() => undefined);
  };

  const handleRecover = () => {
    if (!current?.url) return;
    void browser.navigate(current.id, current.url).catch(() => undefined);
  };

  const handleOpenExternal = () => {
    if (!currentUrl || isLocalCurrent) return;
    void window.filework.openExternal(currentUrl);
  };

  const iconButton =
    "grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30";

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden bg-background">
      <BrowserTabStrip
        tabs={browser.tabs}
        closeLabel={LL.browser_close()}
        newTabLabel={LL.browser_start_title()}
        onActivate={(tabId) => {
          void browser.activateTab(tabId).catch(() => undefined);
        }}
        onClose={(tabId) => {
          void browser.closeTab(tabId).catch(() => undefined);
        }}
        onCreate={() => {
          void browser.createTab({ kind: "web" }).catch(() => undefined);
        }}
      />

      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background/95 px-2">
        <button
          type="button"
          className={iconButton}
          disabled={!current?.canGoBack}
          title={LL.browser_back()}
          aria-label={LL.browser_back()}
          onClick={() => {
            if (current) void browser.command(current.id, "back");
          }}
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={!current?.canGoForward}
          title={LL.browser_forward()}
          aria-label={LL.browser_forward()}
          onClick={() => {
            if (current) void browser.command(current.id, "forward");
          }}
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={!current}
          title={current?.loading ? LL.browser_stop() : LL.browser_reload()}
          aria-label={
            current?.loading ? LL.browser_stop() : LL.browser_reload()
          }
          onClick={handleReloadOrStop}
        >
          {current?.loading ? (
            <X className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
        <form onSubmit={handleSubmitUrl} className="min-w-0 flex-1">
          <input
            data-browser-address="true"
            type="text"
            value={isLocalCurrent ? localFileLabel(currentUrl) : draftUrl}
            onChange={
              isLocalCurrent
                ? undefined
                : (event) => setDraftUrl(event.target.value)
            }
            readOnly={isLocalCurrent}
            title={isLocalCurrent ? localFilePath(currentUrl) : undefined}
            placeholder={LL.browser_url_placeholder()}
            spellCheck={false}
            className="h-7 w-full rounded-md border border-border/70 bg-muted/35 px-2.5 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-sky-500/60 focus:bg-background"
          />
        </form>
        <button
          type="button"
          className={iconButton}
          disabled={isBlank(currentUrl) || isLocalCurrent}
          title={LL.browser_open_external()}
          aria-label={LL.browser_open_external()}
          onClick={handleOpenExternal}
        >
          <ExternalLink className="size-3.5" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <BrowserViewport active={active && !showStart && !showCrash} />

        {showStart && !showCrash && (
          <div
            data-browser-start-page="true"
            className="absolute inset-0 grid place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_38%,color-mix(in_oklab,var(--accent)_42%,transparent),transparent_42%)] p-6"
          >
            <div className="flex max-w-xs flex-col items-center text-center">
              <div className="mb-3 grid size-11 place-items-center rounded-xl border border-border bg-background/80 shadow-sm">
                <Globe className="size-5 text-sky-500" />
              </div>
              <div className="text-sm font-semibold tracking-tight text-foreground/90">
                {LL.browser_start_title()}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {LL.browser_start_hint()}
              </div>
            </div>
          </div>
        )}

        {showCrash && (
          <div
            data-browser-crash="true"
            className="absolute inset-0 grid place-items-center bg-background p-6 text-center"
          >
            <div className="max-w-xs">
              <RotateCcw className="mx-auto mb-3 size-7 text-destructive/80" />
              <div className="text-sm font-semibold">
                {LL.browser_failed_to_load()}
              </div>
              <button
                type="button"
                data-browser-recover="true"
                onClick={handleRecover}
                className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium hover:bg-accent"
              >
                {LL.browser_reload()}
              </button>
            </div>
          </div>
        )}

        {browser.error && !showCrash && (
          <div className="pointer-events-none absolute right-2 bottom-2 max-w-[80%] rounded border border-destructive/30 bg-background/95 px-2 py-1 font-mono text-[10px] text-destructive shadow-lg">
            {browser.error}
          </div>
        )}
      </div>
    </aside>
  );
}

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

export function normalizeBrowserInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^local-file:\/\//i.test(trimmed)) return trimmed;
  const match = trimmed.match(/^([\w-]+(?:\.[\w-]+)+)(?:[/?#]|$)/);
  if (!match) return null;
  const host = match[1];
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return null;
  }
  const lastLabel = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
  if (FILE_EXTENSIONS.has(lastLabel)) return null;
  return `https://${trimmed}`;
}
