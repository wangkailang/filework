import { Globe } from "lucide-react";
import { useState } from "react";
import type { ArticleMetaPart } from "./types";

interface ArticleMetaBarProps {
  part: ArticleMetaPart;
}

const safeHostname = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const formatTime = (iso: string, lang?: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(lang || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

export const ArticleMetaBar = ({ part }: ArticleMetaBarProps) => {
  const { meta, pageUrl } = part;
  const [iconBroken, setIconBroken] = useState(false);

  const siteLabel =
    meta.siteName ?? (pageUrl ? (safeHostname(pageUrl) ?? null) : null);
  const dateLabel = meta.publishedTime
    ? formatTime(meta.publishedTime, meta.lang)
    : null;

  const chips: Array<{ id: string; node: React.ReactNode }> = [];
  if (siteLabel) chips.push({ id: "site", node: <span>{siteLabel}</span> });
  if (meta.byline)
    chips.push({ id: "byline", node: <span>{meta.byline}</span> });
  if (dateLabel)
    chips.push({
      id: "time",
      node: <time dateTime={meta.publishedTime}>{dateLabel}</time>,
    });

  if (chips.length === 0) return null;

  const interleaved: React.ReactNode[] = [];
  chips.forEach((chip, i) => {
    if (i > 0) {
      interleaved.push(
        <span
          key={`sep-before-${chip.id}`}
          aria-hidden="true"
          className="text-muted-foreground/40"
        >
          ·
        </span>,
      );
    }
    interleaved.push(<span key={chip.id}>{chip.node}</span>);
  });

  const inner = (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
      {meta.favicon && !iconBroken ? (
        <img
          src={meta.favicon}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setIconBroken(true)}
          className="h-3.5 w-3.5 shrink-0 rounded-[2px]"
        />
      ) : (
        <Globe className="h-3.5 w-3.5 shrink-0 opacity-60" />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 truncate">
        {interleaved}
      </div>
    </div>
  );

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted">
      {pageUrl ? (
        <a
          href={pageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="block hover:bg-background/40"
        >
          {inner}
        </a>
      ) : (
        inner
      )}
    </div>
  );
};
