import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { localFileUrl } from "../../lib/local-file-url";
import { ImageLightbox } from "./ImageLightbox";
import type { ImagePart } from "./types";

interface MediaImageCardProps {
  part: ImagePart;
}

/**
 * Render a generated image inline in the chat. The file lives under
 * ~/.filework/generated/{sessionId}/... and is served via the
 * `local-file://` custom protocol (registered in main/index.ts).
 *
 * The card shows the prompt and model below the image so users can
 * trace which config produced it — useful when juggling multiple
 * MiniMax image configs (e.g. `image-01` vs `image-01-live`). Click
 * the thumbnail to open a full-size lightbox.
 */
export const MediaImageCard = ({ part }: MediaImageCardProps) => {
  const src = localFileUrl(part.path);
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 inline-flex w-fit max-w-full flex-col self-start overflow-hidden rounded-lg border border-border/70 bg-background shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="查看大图"
        className="block max-w-full bg-muted/35 focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <img
          src={src}
          alt={part.prompt}
          className="block max-h-[520px] max-w-full cursor-zoom-in object-contain"
        />
      </button>
      <div className="flex min-w-0 items-start gap-2 border-t border-border/60 bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
        <ImageIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
        <div className="min-w-0 flex-1">
          <div className="break-words leading-relaxed text-foreground/90">
            {part.prompt}
          </div>
          {part.modelId && (
            <div className="mt-0.5 opacity-60">{part.modelId}</div>
          )}
        </div>
      </div>
      {open && (
        <ImageLightbox
          src={src}
          alt={part.prompt}
          caption={
            <>
              <div className="line-clamp-3">{part.prompt}</div>
              {part.modelId && (
                <div className="mt-1 opacity-70">{part.modelId}</div>
              )}
            </>
          }
          revealPath={part.path}
          downloadName={part.path.split("/").filter(Boolean).pop()}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
