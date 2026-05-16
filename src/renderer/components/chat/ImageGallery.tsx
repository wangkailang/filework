import { ChevronLeft, ChevronRight, Images, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { safeHostname } from "./helpers";
import type { ImageGalleryPart } from "./types";

interface ImageGalleryProps {
  part: ImageGalleryPart;
}

const headerLabel = (part: ImageGalleryPart): string => {
  if (part.source === "web-search")
    return part.context ? `搜索: ${part.context}` : "图片搜索";
  if (part.source === "web-fetch")
    return part.context
      ? `来自 ${safeHostname(part.context) ?? part.context}`
      : "页面图片";
  return "图集";
};

// 1 → 1 col, 2-4 → 2 cols, 5+ → 2 / 3 responsive cols.
const gridColsFor = (n: number): string => {
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  return "grid-cols-2 sm:grid-cols-3";
};

export const ImageGallery = ({ part }: ImageGalleryProps) => {
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  const [lightbox, setLightbox] = useState<number | null>(null);

  const visible = useMemo(
    () =>
      part.images
        .map((img, i) => ({ ...img, _idx: i }))
        .filter((img) => !failed.has(img._idx)),
    [part.images, failed],
  );

  const markFailed = useCallback((idx: number) => {
    setFailed((prev) => {
      if (prev.has(idx)) return prev;
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, []);

  const close = useCallback(() => setLightbox(null), []);
  const step = useCallback(
    (dir: 1 | -1) => {
      setLightbox((cur) => {
        if (cur === null || visible.length === 0) return cur;
        const pos = visible.findIndex((v) => v._idx === cur);
        if (pos === -1) return visible[0]._idx;
        const nextPos = (pos + dir + visible.length) % visible.length;
        return visible[nextPos]._idx;
      });
    },
    [visible],
  );

  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, close, step]);

  if (visible.length === 0) return null;

  const activeImage = lightbox !== null ? part.images[lightbox] : null;
  const activeHost = activeImage?.sourceUrl
    ? safeHostname(activeImage.sourceUrl)
    : null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <Images className="h-3.5 w-3.5 opacity-60" />
        <span className="truncate">{headerLabel(part)}</span>
        <span className="ml-auto opacity-60">{visible.length} 张</span>
      </div>
      <div className={`grid gap-1 p-1 ${gridColsFor(visible.length)}`}>
        {part.images.map((img, idx) => {
          if (failed.has(idx)) return null;
          const host = img.sourceUrl ? safeHostname(img.sourceUrl) : null;
          return (
            <button
              key={img.url}
              type="button"
              onClick={() => setLightbox(idx)}
              className="group relative aspect-[4/3] overflow-hidden rounded bg-background/50 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <img
                src={img.url}
                alt={img.description ?? ""}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => markFailed(idx)}
                className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
              />
              {host && (
                <span className="pointer-events-none absolute bottom-1 right-1 max-w-[80%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-tight text-white/90">
                  {host}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {activeImage && (
        // Lightbox layout: an absolute backdrop <button> handles
        // click-to-close so the inner content stays a non-interactive
        // div (no fake-button accessibility warnings, no stopPropagation
        // gymnastics). Content sits above the backdrop via z-index.
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="关闭图集"
            onClick={close}
            className="absolute inset-0 bg-black/80"
          />
          <button
            type="button"
            aria-label="关闭"
            onClick={close}
            className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          {visible.length > 1 && (
            <>
              <button
                type="button"
                aria-label="上一张"
                onClick={() => step(-1)}
                className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="下一张"
                onClick={() => step(1)}
                className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto flex max-h-full max-w-full flex-col items-center gap-3">
              <img
                src={activeImage.url}
                alt={activeImage.description ?? ""}
                referrerPolicy="no-referrer"
                onError={() => {
                  if (lightbox !== null) markFailed(lightbox);
                  close();
                }}
                className="max-h-[80vh] max-w-[90vw] rounded object-contain"
              />
              {(activeImage.description || activeImage.sourceUrl) && (
                <div className="max-w-[90vw] text-center text-xs text-white/80">
                  {activeImage.description && (
                    <div className="line-clamp-2">
                      {activeImage.description}
                    </div>
                  )}
                  {activeImage.sourceUrl && (
                    <a
                      href={activeImage.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-block underline opacity-80 hover:opacity-100"
                    >
                      {activeHost ?? activeImage.sourceUrl}
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
