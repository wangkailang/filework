import { FolderPlus, Info } from "lucide-react";
import type { CreateDirectoryPreview } from "../../../../main/core/agent/preview/types";
import type { TranslationFunctions } from "../../../i18n/i18n-types";

interface CreateDirectoryPreviewCardProps {
  preview: CreateDirectoryPreview;
  LL: TranslationFunctions;
}

export function CreateDirectoryPreviewCard({
  preview,
  LL,
}: CreateDirectoryPreviewCardProps) {
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1 truncate">
        <FolderPlus className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-mono truncate">{preview.path}</span>
      </div>
      {(preview.alreadyExists || !preview.parentExists) && (
        <div className="ml-4 mt-0.5 flex items-center gap-1 text-amber-400">
          <Info className="size-3 shrink-0" />
          <span>
            {preview.alreadyExists
              ? LL.preview_already_exists()
              : LL.preview_parent_missing()}
          </span>
        </div>
      )}
    </div>
  );
}
