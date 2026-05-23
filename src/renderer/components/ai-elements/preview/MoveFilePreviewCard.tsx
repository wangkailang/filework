import { ArrowRight, FileWarning } from "lucide-react";
import type { MoveFilePreview } from "../../../../main/core/agent/preview/types";
import type { TranslationFunctions } from "../../../i18n/i18n-types";

interface MoveFilePreviewCardProps {
  preview: MoveFilePreview;
  LL: TranslationFunctions;
}

export function MoveFilePreviewCard({ preview, LL }: MoveFilePreviewCardProps) {
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1 truncate">
        <span className="text-muted-foreground/80">
          {LL.preview_card_title_move()}
        </span>
      </div>
      <div className="ml-1 mt-0.5 font-mono flex items-center gap-1 flex-wrap break-all">
        <span className="truncate">{preview.source}</span>
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{preview.destination}</span>
      </div>
      {(!preview.sourceExists || preview.destinationExists) && (
        <div className="ml-1 mt-0.5 flex items-center gap-1 text-red-400">
          <FileWarning className="size-3 shrink-0" />
          <span>
            {!preview.sourceExists
              ? LL.preview_source_missing()
              : LL.preview_destination_exists()}
          </span>
        </div>
      )}
    </div>
  );
}
