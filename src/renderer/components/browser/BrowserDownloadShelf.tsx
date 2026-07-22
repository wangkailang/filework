import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderSearch2,
  Loader2,
  XCircle,
} from "lucide-react";

import type {
  BrowserDownloadState,
  BrowserDownloadStatus,
} from "../../../shared/browser";
import { useI18nContext } from "../../i18n/i18n-react";

interface BrowserDownloadShelfProps {
  downloads: BrowserDownloadState[];
}

const statusIcon = (status: BrowserDownloadStatus) => {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-3.5 text-emerald-500" />;
    case "cancelled":
      return <XCircle className="size-3.5 text-muted-foreground" />;
    case "interrupted":
      return <AlertCircle className="size-3.5 text-destructive" />;
    case "progressing":
      return <Loader2 className="size-3.5 animate-spin text-sky-500" />;
  }
};

export function BrowserDownloadShelf({ downloads }: BrowserDownloadShelfProps) {
  const { LL } = useI18nContext();
  if (downloads.length === 0) return null;

  const statusLabel = (download: BrowserDownloadState): string => {
    switch (download.status) {
      case "completed":
        return LL.browserDownload_completed();
      case "cancelled":
        return LL.browserDownload_cancelled();
      case "interrupted":
        return LL.browserDownload_interrupted();
      case "progressing": {
        const percent =
          download.totalBytes > 0
            ? Math.min(
                100,
                Math.max(
                  0,
                  Math.round(
                    (download.receivedBytes / download.totalBytes) * 100,
                  ),
                ),
              )
            : 0;
        return LL.browserDownload_progress({ percent });
      }
    }
  };

  return (
    <section
      data-browser-downloads="true"
      aria-live="polite"
      className="absolute right-2 bottom-2 z-20 w-[min(22rem,calc(100%-1rem))] overflow-hidden rounded-lg border border-border bg-background/95 shadow-xl backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        <Download className="size-3.5" />
        {LL.browserSettings_downloads()}
      </div>
      <div className="divide-y divide-border">
        {downloads.slice(0, 3).map((download) => (
          <div
            key={download.id}
            className="flex items-start gap-2.5 px-3 py-2.5"
          >
            <div className="mt-0.5">{statusIcon(download.status)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {download.filename}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {statusLabel(download)}
                </span>
              </div>
              {download.status === "progressing" && download.totalBytes > 0 && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-[width]"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          (download.receivedBytes / download.totalBytes) * 100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
              )}
              {download.savePath && (
                <div className="mt-1 flex min-w-0 items-center gap-1">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={download.savePath}
                  >
                    {download.savePath}
                  </span>
                  {download.status === "completed" && (
                    <button
                      type="button"
                      title={LL.browserDownload_showInFinder()}
                      aria-label={LL.browserDownload_showInFinder()}
                      onClick={() =>
                        window.filework.showInFinder(download.savePath ?? "")
                      }
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <FolderSearch2 className="size-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
