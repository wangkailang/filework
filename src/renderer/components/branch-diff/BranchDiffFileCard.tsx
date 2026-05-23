import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  FileX,
} from "lucide-react";
import type { ReactNode } from "react";
import type { GitFileDiff } from "../../../main/core/git-diff/types";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import { cn } from "../../lib/utils";
import {
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationQuote,
  InlineCitationSource,
} from "../ai-elements/inline-citation";
import { DiffHunkView } from "../ai-elements/preview/DiffHunkView";

interface BranchDiffFileCardProps {
  file: GitFileDiff;
  LL: TranslationFunctions;
  /** Default-open at mount. */
  defaultOpen?: boolean;
}

export function BranchDiffFileCard({
  file,
  LL,
  defaultOpen = false,
}: BranchDiffFileCardProps) {
  const StatusIcon = pickStatusIcon(file.status);

  return (
    <InlineCitationCard
      defaultOpen={defaultOpen}
      className={cn(
        "group",
        file.status === "deleted" && "border-red-500/30 bg-red-500/5",
      )}
    >
      <InlineCitationCardTrigger>
        <ExpansionChevron />
        <StatusIcon className="size-3 shrink-0 text-muted-foreground" />
        {file.oldPath ? (
          <span className="font-mono truncate flex items-center gap-1 min-w-0">
            <span className="truncate text-muted-foreground/80">
              {file.oldPath}
            </span>
            <ArrowRight className="size-3 shrink-0" />
            <span className="truncate">{file.path}</span>
          </span>
        ) : (
          <span className="font-mono truncate">{file.path}</span>
        )}
        <span className="ml-auto font-mono whitespace-nowrap text-[10px]">
          <Badge file={file} />
        </span>
      </InlineCitationCardTrigger>

      <InlineCitationCardBody>
        <InlineCitationSource
          title={file.path}
          url={file.oldPath ? `← ${file.oldPath}` : undefined}
          description={describe(file, LL)}
        />
        {renderQuote(file, LL)}
      </InlineCitationCardBody>
    </InlineCitationCard>
  );
}

function ExpansionChevron() {
  // Hide/show the chevron based on the parent card's data-state attribute
  // (set by InlineCitationCard). Avoids a second open-state subscription.
  return (
    <>
      <ChevronRight className="size-3 shrink-0 text-muted-foreground group-data-[state=open]:hidden" />
      <ChevronDown className="size-3 shrink-0 text-muted-foreground hidden group-data-[state=open]:block" />
    </>
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

function describe(file: GitFileDiff, LL: TranslationFunctions): string {
  if (file.status === "added") {
    return `${LL.tool_summary_new_file()} · +${file.added}`;
  }
  if (file.status === "deleted") return `deleted · -${file.removed}`;
  if (file.status === "renamed")
    return `renamed · +${file.added} -${file.removed}`;
  return `+${file.added} -${file.removed}`;
}

function renderQuote(file: GitFileDiff, LL: TranslationFunctions): ReactNode {
  if (file.isBinary) {
    return (
      <div className="text-muted-foreground italic">
        ({LL.tool_diff_label()}) {LL.preview_binary_skipped()}
      </div>
    );
  }
  if (file.hunks.length === 0) {
    return (
      <div className="text-muted-foreground italic">
        {LL.preview_no_changes()}
      </div>
    );
  }
  return (
    <>
      <InlineCitationQuote className="font-mono whitespace-pre-wrap break-all bg-background/40 rounded px-0 not-italic">
        <div className="rounded">
          {file.hunks.map((h, i) => (
            <DiffHunkView
              // biome-ignore lint/suspicious/noArrayIndexKey: hunk position is the identity
              key={`${i}-${h.value.slice(0, 8)}`}
              hunk={h}
              collapseContext={true}
            />
          ))}
        </div>
      </InlineCitationQuote>
      {file.truncated && (
        <div className="mt-1 px-2 text-muted-foreground italic">
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
