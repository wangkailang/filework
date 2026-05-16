import { Globe } from "lucide-react";
import { useState } from "react";
import { safeHostname } from "./helpers";
import type { ArticleMetaPart } from "./types";

interface ArticleMetaBarProps {
  part: ArticleMetaPart;
}

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

  const chips: React.ReactElement[] = [];
  if (siteLabel) chips.push(<span key="site">{siteLabel}</span>);
  if (meta.byline) chips.push(<span key="byline">{meta.byline}</span>);
  if (dateLabel)
    chips.push(
      <time key="time" dateTime={meta.publishedTime}>
        {dateLabel}
      </time>,
    );

  if (chips.length === 0) return null;

  const interleaved: React.ReactNode[] = [];
  chips.forEach((chip, i) => {
    if (i > 0) {
      interleaved.push(
        <span
          key={`sep-${chip.key}`}
          aria-hidden="true"
          className="text-muted-foreground/40"
        >
          ·
        </span>,
      );
    }
    interleaved.push(chip);
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
