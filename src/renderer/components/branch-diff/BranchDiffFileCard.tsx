import {
  ArrowRight,
  ChevronDown,
  FilePlus,
  FileText,
  FileX,
} from "lucide-react";
import type { ReactNode } from "react";
import type { GitFileDiff } from "../../../main/core/git-diff/types";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import { cn } from "../../lib/utils";
import { DiffHunkView } from "../ai-elements/preview/DiffHunkView";

interface BranchDiffFileCardProps {
  file: GitFileDiff;
  LL: TranslationFunctions;
  /** 挂载时默认展开。 */
  defaultOpen?: boolean;
}

export function BranchDiffFileCard({
  file,
  LL,
  defaultOpen = true,
}: BranchDiffFileCardProps) {
  const StatusIcon = pickStatusIcon(file.status);

  return (
    <details
      data-branch-diff-file="true"
      open={defaultOpen}
      className={cn(
        "group overflow-hidden border-y border-border-faint bg-surface text-xs",
        "first:border-t-0",
        file.status === "deleted" && "bg-status-error/5",
      )}
    >
      <summary
        className={cn(
          "flex min-h-8 cursor-pointer list-none items-center gap-2 border-b border-border-faint bg-card/70 px-2 py-1.5",
          "text-muted-foreground transition-colors hover:bg-accent/45",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronDown
          className="size-3 shrink-0 transition-transform group-open:rotate-0 -rotate-90"
          aria-hidden="true"
        />
        <StatusIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {file.oldPath ? (
          <span className="flex min-w-0 items-center gap-1 truncate font-mono">
            <span className="truncate text-muted-foreground/80">
              {file.oldPath}
            </span>
            <ArrowRight className="size-3 shrink-0" />
            <span className="truncate">{file.path}</span>
          </span>
        ) : (
          <span className="font-mono truncate">{file.path}</span>
        )}
        <span className="ml-auto whitespace-nowrap font-mono text-[11px]">
          <Badge file={file} />
        </span>
      </summary>

      <div className="bg-surface-sunken">{renderQuote(file, LL)}</div>
    </details>
  );
}

function Badge({ file }: { file: GitFileDiff }): ReactNode {
  if (file.isBinary) {
    return <span className="text-muted-foreground italic">binary</span>;
  }
  return (
    <>
      <span className="text-emerald-500">+{file.added}</span>{" "}
      <span className="text-red-400">-{file.removed}</span>
    </>
  );
}

function renderQuote(file: GitFileDiff, LL: TranslationFunctions): ReactNode {
  if (file.isBinary) {
    return (
      <div className="px-3 py-2 text-muted-foreground italic">
        ({LL.tool_diff_label()}) {LL.preview_binary_skipped()}
      </div>
    );
  }
  if (file.hunks.length === 0) {
    return (
      <div className="px-3 py-2 text-muted-foreground italic">
        {LL.preview_no_changes()}
      </div>
    );
  }
  return (
    <>
      <div
        data-branch-diff-code="true"
        className="overflow-x-auto font-mono text-[12px] leading-6"
      >
        <div className="min-w-full">
          {file.hunks.map((h, i) => (
            <DiffHunkView
              // biome-ignore lint/suspicious/noArrayIndexKey: hunk position is the identity
              key={`${i}-${h.value.slice(0, 8)}`}
              hunk={h}
              collapseContext={true}
              density="branch"
            />
          ))}
        </div>
      </div>
      {file.truncated && (
        <div className="border-t border-border-faint px-3 py-2 text-muted-foreground italic">
          {LL.preview_diff_truncated()}
        </div>
      )}
    </>
  );
}

function pickStatusIcon(status: GitFileDiff["status"]) {
  if (status === "added") return FilePlus;
  if (status === "deleted") return FileX;
  return FileText;
}
