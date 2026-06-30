import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Images,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { safeHostname } from "./helpers";
import { ImageDownloadButton } from "./ImageLightbox";
import type { ImageGalleryPart } from "./types";

interface ImageGalleryProps {
  part: ImageGalleryPart;
}

const headerLabel = (part: ImageGalleryPart): string => {
  if (part.source === "web-search")
    return part.context ? `图片搜索 · ${part.context}` : "图片搜索结果";
  if (part.source === "web-fetch")
    return part.context
      ? `页面图片 · ${safeHostname(part.context) ?? part.context}`
      : "页面图片";
  return "图片结果";
};

// 1 → 1 列,2-4 → 2 列,5+ → 2 / 3 列自适应。
const gridColsFor = (n: number): string => {
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  return "grid-cols-2 sm:grid-cols-3";
};

const filenameFromUrl = (url: string): string => {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? "";
  const name = withoutQuery.split("/").filter(Boolean).pop();
  if (!name) return "image";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

export const ImageGallery = ({ part }: ImageGalleryProps) => {
  const [expanded, setExpanded] = useState(false);
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
  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      if (prev) setLightbox(null);
      return !prev;
    });
  }, []);
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
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, step]);

  if (visible.length === 0) return null;

  const activeImage = lightbox !== null ? part.images[lightbox] : null;
  const activeHost = activeImage?.sourceUrl
    ? safeHostname(activeImage.sourceUrl)
    : null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-background/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <Images className="h-3.5 w-3.5 opacity-60" />
        <span className="min-w-0 flex-1 truncate">{headerLabel(part)}</span>
        <span className="shrink-0 opacity-60">{visible.length} 张图片</span>
        <span className="flex shrink-0 items-center gap-1 opacity-70">
          {expanded ? (
            <>
              收起 <ChevronUp className="h-3.5 w-3.5" />
            </>
          ) : (
            <>
              展开 <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </span>
      </button>
      {expanded && (
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
      )}

      <Dialog
        open={activeImage != null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="titlebar-no-drag inset-0! left-0! top-0! h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! rounded-none! border-0! bg-black/90! p-0! text-white! shadow-none! ring-0!"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Image gallery preview</DialogTitle>
            <DialogDescription>
              Preview images from the gallery in full size.
            </DialogDescription>
          </DialogHeader>
          <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
            {activeImage && (
              <ImageDownloadButton
                src={activeImage.url}
                downloadName={filenameFromUrl(activeImage.url)}
              />
            )}
            <DialogClose asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="关闭"
                className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
              >
                <X />
              </Button>
            </DialogClose>
          </div>
          {activeImage && visible.length > 1 && (
            <>
              <Button
                type="button"
                size="icon-lg"
                variant="ghost"
                aria-label="上一张"
                onClick={() => step(-1)}
                className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                size="icon-lg"
                variant="ghost"
                aria-label="下一张"
                onClick={() => step(1)}
                className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
              >
                <ChevronRight />
              </Button>
            </>
          )}
          {activeImage && (
            <div className="flex h-full w-full items-center justify-center p-4">
              <div className="flex max-h-full max-w-full flex-col items-center gap-3">
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
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
