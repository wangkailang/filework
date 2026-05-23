import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { WriteFilePreview } from "../../../../main/core/agent/preview/types";
import type { TranslationFunctions } from "../../../i18n/i18n-types";
import { cn } from "../../../lib/utils";
import { DiffHunkView } from "./DiffHunkView";

interface WriteFilePreviewCardProps {
  preview: WriteFilePreview;
  LL: TranslationFunctions;
  /** Shown to assistive tech when the body is collapsed. */
  fallbackDescription?: string;
}

export function WriteFilePreviewCard({
  preview,
  LL,
  fallbackDescription,
}: WriteFilePreviewCardProps) {
  const [open, setOpen] = useState(false);
  const isCreate = preview.action === "create";
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1 w-full text-left hover:text-foreground"
      >
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-mono truncate">{preview.path}</span>
        <span
          className={cn(
            "ml-2 font-mono whitespace-nowrap",
            isCreate ? "text-emerald-500" : "",
          )}
        >
          {isCreate ? (
            <>
              <span className="text-emerald-500">
                {LL.tool_summary_new_file()}
              </span>
              <span className="ml-1 text-muted-foreground">
                +{preview.added}
              </span>
            </>
          ) : (
            <>
              <span className="text-emerald-500">+{preview.added}</span>{" "}
              <span className="text-red-400">-{preview.removed}</span>
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="mt-1 ml-4">
          {preview.isBinary ? (
            <div className="px-3 py-2 text-muted-foreground italic">
              ({LL.tool_diff_label()}) binary file, diff skipped
            </div>
          ) : preview.truncated ? (
            <div className="px-3 py-2 text-muted-foreground italic">
              {preview.truncated === "oldTooLarge" ||
              preview.truncated === "newTooLarge"
                ? `(${LL.tool_diff_label()}) file too large (>1 MB); line counts only`
                : `(${LL.tool_diff_label()}) diff truncated`}
              <div className="mt-0.5 font-mono text-foreground/70">
                old: {preview.oldLines} → new: {preview.newLines}
              </div>
            </div>
          ) : preview.hunks.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground italic">
              no changes
            </div>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                {LL.tool_diff_label()}
                {isCreate && (
                  <span className="ml-2 text-emerald-500 normal-case tracking-normal">
                    {LL.tool_summary_new_file()}
                  </span>
                )}
              </div>
              <div className="font-mono whitespace-pre-wrap break-all rounded border border-border bg-background/40">
                {preview.hunks.map((h, i) => (
                  <DiffHunkView
                    // biome-ignore lint/suspicious/noArrayIndexKey: hunk position is the identity
                    key={`${i}-${h.value.slice(0, 8)}`}
                    hunk={h}
                    collapseContext={!isCreate}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {!open && fallbackDescription && (
        <div className="sr-only">{fallbackDescription}</div>
      )}
    </div>
  );
}
