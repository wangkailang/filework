import { useMemo } from "react";
import type { PreviewDiffHunk } from "../../../../main/core/agent/preview/types";
import { cn } from "../../../lib/utils";

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

  const tone =
    hunk.kind === "added"
      ? "bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-500/40"
      : hunk.kind === "removed"
        ? "bg-red-500/10 text-red-300 border-l-2 border-red-500/40"
        : "text-muted-foreground/70";
  const prefix =
    hunk.kind === "added" ? "+ " : hunk.kind === "removed" ? "- " : "  ";

  if (hunk.kind === "context" && collapseContext && lines.length > 6) {
    const head = lines.slice(0, 2);
    const tail = lines.slice(-2);
    const hidden = lines.length - 4;
    return (
      <>
        {head.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
          <span key={`h-${i}`} className={cn("block px-2", tone)}>
            {prefix}
            {l}
          </span>
        ))}
        <span className="block px-2 text-muted-foreground italic">
          {`  … ${hidden} lines`}
        </span>
        {tail.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
          <span key={`t-${i}`} className={cn("block px-2", tone)}>
            {prefix}
            {l}
          </span>
        ))}
      </>
    );
  }

  return (
    <>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff line index is the identity
        <span key={`l-${i}`} className={cn("block px-2", tone)}>
          {prefix}
          {l}
        </span>
      ))}
    </>
  );
}
