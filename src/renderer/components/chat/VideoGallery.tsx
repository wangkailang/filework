import { Film, Play } from "lucide-react";
import { useState } from "react";
import { safeHostname } from "./helpers";
import type { VideoGalleryPart } from "./types";

interface VideoGalleryProps {
  part: VideoGalleryPart;
}

const headerLabel = (part: VideoGalleryPart): string => {
  if (part.context) {
    const host = safeHostname(part.context);
    return host ? `视频 · 来自 ${host}` : "视频";
  }
  return "视频";
};

const providerLabel = (p?: string): string => {
  switch (p) {
    case "youtube":
      return "YouTube";
    case "vimeo":
      return "Vimeo";
    case "bilibili":
      return "Bilibili";
    case "twitter":
      return "X / Twitter";
    default:
      return "视频";
  }
};

// 1 → 1 col, 2+ → 2 cols (videos are heavier visually so we stay at 2
// cols even on wide screens instead of cramming 3).
const gridColsFor = (n: number): string =>
  n <= 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2";

const isIframeProvider = (provider?: string): boolean =>
  provider === "youtube" ||
  provider === "vimeo" ||
  provider === "bilibili" ||
  provider === "twitter";

export const VideoGallery = ({ part }: VideoGalleryProps) => {
  const [playing, setPlaying] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<number>>(() => new Set());

  const visibleCount = part.videos.length - failed.size;
  if (visibleCount <= 0) return null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <Film className="h-3.5 w-3.5 opacity-60" />
        <span className="truncate">{headerLabel(part)}</span>
        <span className="ml-auto opacity-60">{visibleCount} 个</span>
      </div>
      <div className={`grid gap-2 p-2 ${gridColsFor(visibleCount)}`}>
        {part.videos.map((video, idx) => {
          if (failed.has(idx)) return null;
          const host = video.sourceUrl ? safeHostname(video.sourceUrl) : null;
          const isPlaying = playing === idx;
          const useIframe = isIframeProvider(video.provider);

          return (
            <div
              key={video.url}
              className="group relative aspect-video overflow-hidden rounded bg-background/50"
            >
              {isPlaying ? (
                useIframe ? (
                  <iframe
                    src={video.url}
                    title={video.title ?? "embedded video"}
                    referrerPolicy="no-referrer"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    // Intentionally omits allow-same-origin: the embed
                    // doesn't need DOM access to its host, and dropping
                    // it prevents a malicious page from navigating the
                    // parent frame via window.top.
                    sandbox="allow-scripts allow-presentation allow-popups"
                    className="h-full w-full"
                  />
                ) : (
                  <video
                    src={video.url}
                    poster={video.poster}
                    controls
                    autoPlay
                    onError={() => {
                      setFailed((prev) => {
                        const next = new Set(prev);
                        next.add(idx);
                        return next;
                      });
                      setPlaying(null);
                    }}
                    className="h-full w-full bg-black"
                  >
                    <track kind="captions" />
                  </video>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => setPlaying(idx)}
                  className="relative h-full w-full focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label={`播放 ${video.title ?? providerLabel(video.provider)}`}
                >
                  {video.poster ? (
                    <img
                      src={video.poster}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 text-xs text-white/70">
                      {providerLabel(video.provider)}
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                      <Play className="h-6 w-6 translate-x-[1px]" />
                    </span>
                  </div>
                  {host && (
                    <span className="pointer-events-none absolute bottom-1 right-1 max-w-[80%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-tight text-white/90">
                      {host}
                    </span>
                  )}
                </button>
              )}
              {video.title && !isPlaying && (
                <div className="pointer-events-none absolute left-0 right-0 top-0 truncate bg-gradient-to-b from-black/60 to-transparent px-2 py-1 text-xs text-white">
                  {video.title}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
