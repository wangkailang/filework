import { ChevronDown, ChevronRight, FileWarning } from "lucide-react";
import { useState } from "react";
import type { DeleteFilePreview } from "../../../../main/core/agent/preview/types";
import type { TranslationFunctions } from "../../../i18n/i18n-types";

interface DeleteFilePreviewCardProps {
  preview: DeleteFilePreview;
  LL: TranslationFunctions;
}

export function DeleteFilePreviewCard({
  preview,
  LL,
}: DeleteFilePreviewCardProps) {
  const [open, setOpen] = useState(false);
  const hasHead =
    preview.headPreview !== undefined && preview.headPreview.length > 0;
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <div className="text-xs">
      <button
        type="button"
        disabled={!hasHead}
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1 w-full text-left disabled:cursor-default"
      >
        {hasHead ? (
          <Icon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="inline-block size-3 shrink-0" />
        )}
        <span className="font-mono truncate text-red-400">{preview.path}</span>
        <span className="ml-2 text-muted-foreground whitespace-nowrap">
          {preview.type === "dir" && preview.childCount !== undefined
            ? LL.preview_dir_children(preview.childCount)
            : null}
          {preview.sizeBytes !== undefined && (
            <span className="ml-1">
              {LL.preview_size_bytes(preview.sizeBytes)}
            </span>
          )}
        </span>
      </button>
      {!preview.exists && (
        <div className="ml-1 mt-0.5 flex items-center gap-1 text-amber-400">
          <FileWarning className="size-3 shrink-0" />
          <span>{LL.preview_source_missing()}</span>
        </div>
      )}
      {open && hasHead && (
        <pre className="mt-1 ml-4 font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto rounded border border-border bg-background/40 p-2 text-foreground/70">
          {preview.headPreview?.join("\n")}
        </pre>
      )}
    </div>
  );
}
