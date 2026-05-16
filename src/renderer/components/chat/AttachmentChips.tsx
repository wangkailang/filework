import { FileCodeIcon, FileIcon, FileTextIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { localFileUrl } from "../../lib/local-file-url";
import type { AttachmentKind, AttachmentPart } from "./types";

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** Either an AttachmentPart from history or a pending composer entry. */
type ChipData = Omit<AttachmentPart, "type">;

const KindIcon = ({ kind }: { kind: AttachmentKind }) => {
  if (kind === "pdf") return <FileTextIcon className="size-4 text-red-500" />;
  if (kind === "text") return <FileCodeIcon className="size-4 text-blue-500" />;
  return <FileIcon className="size-4 text-muted-foreground" />;
};

/**
 * Composer-side chips row: above the textarea, each chip has a ✕ that
 * calls onRemove. Image kinds show a 40×40 thumbnail via the
 * `local-file://` protocol; pdf/text show a colored lucide icon.
 */
export const AttachmentChips = ({
  attachments,
  onRemove,
}: {
  attachments: ChipData[];
  onRemove: (id: string) => void;
}) => {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {attachments.map((a) => (
        <div
          key={a.attachmentId}
          className="group relative flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        >
          {a.kind === "image" ? (
            <img
              src={localFileUrl(a.path)}
              alt={a.name}
              className="size-8 rounded object-cover"
            />
          ) : (
            <KindIcon kind={a.kind} />
          )}
          <div className="flex flex-col">
            <span
              className="max-w-[12rem] truncate font-medium text-foreground"
              title={a.name}
            >
              {a.name}
            </span>
            <span className="text-muted-foreground">{formatBytes(a.size)}</span>
          </div>
          <button
            type="button"
            onClick={() => onRemove(a.attachmentId)}
            aria-label={`Remove ${a.name}`}
            className="ml-1 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

/**
 * History-side read-only chips on a user message bubble. Clicking a
 * chip reveals the underlying file in Finder via `showInFinder`.
 */
export const AttachmentList = ({
  attachments,
}: {
  attachments: ChipData[];
}) => {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachments.map((a) => (
        <button
          key={a.attachmentId}
          type="button"
          onClick={() => window.filework.showInFinder(a.path)}
          title={`${a.name} — click to reveal in Finder`}
          className="group flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs hover:bg-accent"
        >
          <HistoryThumb a={a} />
          <div className="flex flex-col items-start">
            <span className="max-w-[14rem] truncate font-medium text-foreground">
              {a.name}
            </span>
            <span className="text-muted-foreground">{formatBytes(a.size)}</span>
          </div>
        </button>
      ))}
    </div>
  );
};

/**
 * Image thumbnail with icon fallback. Falls back when the attachment
 * file was removed off-disk between sessions (the `local-file://`
 * handler 404s and the `<img>` `onError` fires).
 */
const HistoryThumb = ({ a }: { a: ChipData }) => {
  const [failed, setFailed] = useState(false);
  if (a.kind !== "image" || failed) return <KindIcon kind={a.kind} />;
  return (
    <img
      src={localFileUrl(a.path)}
      alt={a.name}
      className="size-10 rounded object-cover"
      onError={() => setFailed(true)}
    />
  );
};
