import { FolderX, Terminal } from "lucide-react";
import type { RunCommandPreview } from "../../../../main/core/agent/preview/types";
import type { TranslationFunctions } from "../../../i18n/i18n-types";

interface RunCommandPreviewCardProps {
  preview: RunCommandPreview;
  LL: TranslationFunctions;
}

export function RunCommandPreviewCard({
  preview,
  LL,
}: RunCommandPreviewCardProps) {
  return (
    <div className="text-xs">
      <div className="flex items-start gap-1">
        <Terminal className="size-3 shrink-0 text-muted-foreground mt-0.5" />
        <code className="font-mono text-foreground/90 break-all">
          {preview.command}
        </code>
      </div>
      {preview.cwd && (
        <div
          className={`ml-4 mt-0.5 font-mono text-[10px] ${
            preview.cwdExists ? "text-muted-foreground" : "text-red-400"
          }`}
        >
          cwd: {preview.cwd}
        </div>
      )}
      {!preview.cwdExists && preview.cwd && (
        <div className="ml-4 mt-0.5 flex items-center gap-1 text-red-400">
          <FolderX className="size-3 shrink-0" />
          <span>{LL.preview_cwd_missing()}</span>
        </div>
      )}
    </div>
  );
}
