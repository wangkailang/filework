import { useMemo } from "react";
import type { PreviewDiffHunk } from "../../../../main/core/agent/preview/types";
import { cn } from "../../../lib/utils";

const DIFF_LINE_GRID_CLASS =
  "grid w-max min-w-full grid-cols-[3rem_3rem_1.5rem_max-content]";

interface DiffHunkViewProps {
  hunk: PreviewDiffHunk;
  /** 为 true 时,≥6 行的「上下文」hunk 仅渲染首/尾,并以
   *  「… N lines」标记表示。新增/删除的 hunk 永不折叠。 */
  collapseContext: boolean;
}

export function DiffHunkView({ hunk, collapseContext }: DiffHunkViewProps) {
  const lines = useMemo(() => {
    const v = hunk.value.endsWith("\n") ? hunk.value.slice(0, -1) : hunk.value;
    return v.split("\n");
  }, [hunk.value]);

  if (hunk.kind === "context" && collapseContext && lines.length > 6) {
    const head = lines.slice(0, 2);
    const tail = lines.slice(-2);
    const hidden = lines.length - 4;
    return (
      <>
        {head.map((l, i) => (
          <DiffLine
            // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
            key={`h-${i}`}
            index={i}
            kind={hunk.kind}
            newStart={hunk.newStart}
            oldStart={hunk.oldStart}
            text={l}
          />
        ))}
        <OmittedLine hidden={hidden} />
        {tail.map((l, i) => (
          <DiffLine
            // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
            key={`t-${i}`}
            index={lines.length - tail.length + i}
            kind={hunk.kind}
            newStart={hunk.newStart}
            oldStart={hunk.oldStart}
            text={l}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {lines.map((l, i) => (
        <DiffLine
          // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
          key={`l-${i}`}
          index={i}
          kind={hunk.kind}
          newStart={hunk.newStart}
          oldStart={hunk.oldStart}
          text={l}
        />
      ))}
    </>
  );
}

function DiffLine({
  kind,
  text,
  index,
  oldStart,
  newStart,
}: {
  kind: PreviewDiffHunk["kind"];
  text: string;
  index: number;
  oldStart?: number;
  newStart?: number;
}) {
  if (kind === "context" && text.startsWith("@@")) {
    return (
      <div
        data-diff-line-kind="hunk"
        data-diff-marker="@@"
        className={cn(
          DIFF_LINE_GRID_CLASS,
          "border-l-2 border-primary/25 bg-primary/5 text-primary-bright/80",
        )}
      >
        <span
          className={cn(gutterClassName("hunk"), stickyColumnClassName(0))}
          aria-hidden="true"
        />
        <span
          className={cn(gutterClassName("hunk"), stickyColumnClassName(1))}
          aria-hidden="true"
        />
        <span
          className={cn(
            markerClassName("hunk"),
            stickyColumnClassName(2),
            "text-primary-bright/80",
          )}
          aria-hidden="true"
        >
          @@
        </span>
        <span className="whitespace-pre px-2">{text}</span>
      </div>
    );
  }

  const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
  const oldLine =
    kind === "added" || oldStart === undefined ? "" : String(oldStart + index);
  const newLine =
    kind === "removed" || newStart === undefined
      ? ""
      : String(newStart + index);

  return (
    <div
      data-diff-line-kind={kind}
      data-diff-marker={marker}
      className={cn(
        DIFF_LINE_GRID_CLASS,
        "border-l-2 text-foreground/85",
        kind === "added" && "border-status-success/25 bg-status-success/5",
        kind === "removed" && "border-status-error/25 bg-status-error/5",
        kind === "context" && "border-transparent bg-muted/10",
      )}
    >
      <span
        className={cn(gutterClassName(kind), stickyColumnClassName(0))}
        aria-hidden="true"
      >
        {oldLine}
      </span>
      <span
        className={cn(gutterClassName(kind), stickyColumnClassName(1))}
        aria-hidden="true"
      >
        {newLine}
      </span>
      <span
        className={cn(
          markerClassName(kind),
          stickyColumnClassName(2),
          kind === "added" && "text-status-success/75",
          kind === "removed" && "text-status-error/75",
          kind === "context" && "text-muted-foreground/55",
        )}
        aria-hidden="true"
      >
        {marker}
      </span>
      <span className="whitespace-pre px-2">{text}</span>
    </div>
  );
}

function OmittedLine({ hidden }: { hidden: number }) {
  return (
    <div
      data-diff-line-kind="omitted"
      data-diff-marker="…"
      className={cn(
        DIFF_LINE_GRID_CLASS,
        "border-l-2 border-muted-foreground/20 bg-muted/25 text-muted-foreground/75 italic",
      )}
    >
      <span
        className={cn(gutterClassName("omitted"), stickyColumnClassName(0))}
        aria-hidden="true"
      />
      <span
        className={cn(gutterClassName("omitted"), stickyColumnClassName(1))}
        aria-hidden="true"
      />
      <span
        className={cn(markerClassName("omitted"), stickyColumnClassName(2))}
        aria-hidden="true"
      >
        …
      </span>
      <span className="whitespace-pre px-2">{`${hidden} lines`}</span>
    </div>
  );
}

function stickyColumnClassName(column: 0 | 1 | 2) {
  return cn(
    "sticky",
    column === 0 && "left-0",
    column === 1 && "left-[3rem]",
    column === 2 && "left-[6rem]",
    "z-10",
  );
}

function markerClassName(kind: PreviewDiffHunk["kind"] | "hunk" | "omitted") {
  return cn(
    "select-none border-r px-1 text-center",
    kind === "added" && "border-status-success/15 bg-status-success/5",
    kind === "removed" && "border-status-error/15 bg-status-error/5",
    kind === "context" && "border-border/40 bg-muted/10",
    kind === "hunk" && "border-primary/15 bg-primary/5",
    kind === "omitted" && "border-muted-foreground/10 bg-muted/25",
  );
}

function gutterClassName(kind: PreviewDiffHunk["kind"] | "hunk" | "omitted") {
  return cn(
    "select-none border-r px-2 text-right text-[10px]",
    kind === "added" &&
      "border-status-success/15 bg-status-success/5 text-status-success/65",
    kind === "removed" &&
      "border-status-error/15 bg-status-error/5 text-status-error/65",
    kind === "context" &&
      "border-border/40 bg-muted/10 text-muted-foreground/40",
    kind === "hunk" && "border-primary/15 bg-primary/5 text-primary-bright/60",
    kind === "omitted" &&
      "border-muted-foreground/10 bg-muted/25 text-muted-foreground/55",
  );
}
