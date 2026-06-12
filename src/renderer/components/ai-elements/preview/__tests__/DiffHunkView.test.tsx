import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffHunkView } from "../DiffHunkView";

describe("DiffHunkView", () => {
  it("renders added and removed lines with GitHub-style gutters", () => {
    const html = renderToStaticMarkup(
      <div>
        <DiffHunkView
          collapseContext={false}
          hunk={{
            kind: "removed",
            value: "old line\n",
            lineCount: 1,
            oldStart: 12,
          }}
        />
        <DiffHunkView
          collapseContext={false}
          hunk={{
            kind: "added",
            value: "new line\n",
            lineCount: 1,
            newStart: 13,
          }}
        />
      </div>,
    );

    expect(html).toContain('data-diff-line-kind="removed"');
    expect(html).toContain('data-diff-line-kind="added"');
    expect(html).toContain('data-diff-marker="-"');
    expect(html).toContain('data-diff-marker="+"');
    expect(html).toContain('aria-hidden="true">12</span>');
    expect(html).toContain('aria-hidden="true">13</span>');
    expect(html).toContain('aria-hidden="true">-</span>');
    expect(html).toContain('aria-hidden="true">+</span>');
  });

  it("keeps gutters aligned while long lines scroll horizontally", () => {
    const html = renderToStaticMarkup(
      <DiffHunkView
        collapseContext={false}
        hunk={{
          kind: "added",
          value: `${"very long line ".repeat(20)}\n`,
          lineCount: 1,
          newStart: 1,
        }}
      />,
    );

    expect(html).toContain("w-max min-w-full");
    expect(html).toContain("grid-cols-[3rem_3rem_1.5rem_max-content]");
    expect(html).toContain("sticky left-0");
    expect(html).toContain("sticky left-[3rem]");
    expect(html).toContain("sticky left-[6rem]");
  });
});
