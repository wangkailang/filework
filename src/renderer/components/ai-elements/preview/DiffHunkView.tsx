import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { PreviewDiffHunk } from "../../../../main/core/agent/preview/types";
import { cn } from "../../../lib/utils";

const DIFF_LINE_GRID_CLASS =
  "grid w-max min-w-full grid-cols-[3rem_3rem_1.5rem_max-content]";
const BRANCH_DIFF_LINE_GRID_CLASS =
  "grid w-max min-w-full grid-cols-[4rem_1.5rem_max-content]";
const BRANCH_DIFF_OMITTED_GRID_CLASS =
  "grid w-max min-w-full grid-cols-[4rem_max-content]";

interface DiffHunkViewProps {
  hunk: PreviewDiffHunk;
  /** 为 true 时,≥6 行的「上下文」hunk 仅渲染首/尾,并以
   *  「… N lines」标记表示。新增/删除的 hunk 永不折叠。 */
  collapseContext: boolean;
  density?: "card" | "branch";
}

export function DiffHunkView({
  hunk,
  collapseContext,
  density = "card",
}: DiffHunkViewProps) {
  const lines = useMemo(() => {
    const v = hunk.value.endsWith("\n") ? hunk.value.slice(0, -1) : hunk.value;
    return v.split("\n");
  }, [hunk.value]);

  if (density === "branch" && hunk.kind === "context" && lines.length === 1) {
    const omitted = parseHunkOmittedLineCount(lines[0]);
    if (omitted !== null) {
      return <OmittedLine hidden={omitted} density="branch" />;
    }
  }

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
            density={density}
          />
        ))}
        <OmittedLine hidden={hidden} density={density} />
        {tail.map((l, i) => (
          <DiffLine
            // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
            key={`t-${i}`}
            index={lines.length - tail.length + i}
            kind={hunk.kind}
            newStart={hunk.newStart}
            oldStart={hunk.oldStart}
            text={l}
            density={density}
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
          density={density}
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
  density = "card",
}: {
  kind: PreviewDiffHunk["kind"];
  text: string;
  index: number;
  oldStart?: number;
  newStart?: number;
  density?: DiffHunkViewProps["density"];
}) {
  if (density === "branch") {
    return (
      <BranchDiffLine
        kind={kind}
        text={text}
        index={index}
        oldStart={oldStart}
        newStart={newStart}
      />
    );
  }

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

function BranchDiffLine({
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
  const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
  const lineNumber =
    kind === "removed"
      ? oldStart !== undefined
        ? String(oldStart + index)
        : ""
      : newStart !== undefined
        ? String(newStart + index)
        : "";

  return (
    <div
      data-diff-density="branch"
      data-diff-line-kind={kind}
      data-diff-marker={marker}
      className={cn(
        BRANCH_DIFF_LINE_GRID_CLASS,
        "border-l text-foreground/90",
        kind === "added" &&
          "border-status-success/45 bg-status-success/15 text-status-success",
        kind === "removed" &&
          "border-status-error/45 bg-status-error/15 text-status-error",
        kind === "context" &&
          "border-transparent bg-surface-sunken text-foreground/80",
      )}
    >
      <span
        className={cn(
          "select-none border-r border-border-faint px-2 text-right text-[11px]",
          kind === "added" && "text-status-success",
          kind === "removed" && "text-status-error",
          kind === "context" && "text-muted-foreground/70",
        )}
        aria-hidden="true"
      >
        {lineNumber}
      </span>
      <span
        className={cn(
          "select-none text-center text-[11px]",
          kind === "added" && "text-status-success",
          kind === "removed" && "text-status-error",
          kind === "context" && "text-muted-foreground/45",
        )}
        aria-hidden="true"
      >
        {marker}
      </span>
      <span className="whitespace-pre px-2">
        <CodeText text={text} kind={kind} />
      </span>
    </div>
  );
}

function CodeText({
  text,
  kind,
}: {
  text: string;
  kind: PreviewDiffHunk["kind"];
}) {
  if (kind === "context" && /^\s*(\/\*|\*|\/\/)/.test(text)) {
    return <span className="text-muted-foreground/70">{text}</span>;
  }

  const tokenPattern =
    /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|type|interface|import|export|from|expect|toContain|not)\b|\b\d+(?:\.\d+)?\b)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    nodes.push(
      <span key={index} className={codeTokenClassName(value)}>
        {value}
      </span>,
    );
    lastIndex = index + value.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes}</>;
}

function codeTokenClassName(value: string) {
  if (/^['"`]/.test(value)) return "text-status-await";
  if (/^\d/.test(value)) return "text-primary-bright";
  return "text-primary-bright italic";
}

function OmittedLine({
  hidden,
  density = "card",
}: {
  hidden: number;
  density?: DiffHunkViewProps["density"];
}) {
  if (density === "branch") {
    return (
      <div
        data-diff-density="branch"
        data-diff-line-kind="omitted"
        data-diff-marker="…"
        className={cn(
          BRANCH_DIFF_OMITTED_GRID_CLASS,
          "border-y border-border-faint bg-muted/50 text-[11px] text-muted-foreground",
        )}
      >
        <span className="flex items-center justify-center border-r border-border-faint">
          <ChevronDown className="size-3" aria-hidden="true" />
        </span>
        <span className="whitespace-pre px-2">{`${hidden} unmodified lines`}</span>
      </div>
    );
  }

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

function parseHunkOmittedLineCount(text: string): number | null {
  const match = /^@@ -(\d+)/.exec(text);
  if (!match) return null;
  const start = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, start - 1);
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
