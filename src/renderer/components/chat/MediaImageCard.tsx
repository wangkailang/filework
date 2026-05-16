import { ImageIcon } from "lucide-react";
import { localFileUrl } from "../../lib/local-file-url";
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
 * MiniMax image configs (e.g. `image-01` vs `image-01-live`).
 */
export const MediaImageCard = ({ part }: MediaImageCardProps) => {
  const src = localFileUrl(part.path);
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted">
      <img
        src={src}
        alt={part.prompt}
        className="block max-w-full max-h-[480px] bg-background"
      />
      <div className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
        <ImageIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
        <div className="min-w-0 flex-1">
          <div className="break-words text-foreground/90">{part.prompt}</div>
          {part.modelId && (
            <div className="mt-0.5 opacity-60">{part.modelId}</div>
          )}
        </div>
      </div>
    </div>
  );
};
