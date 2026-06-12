import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranslationFunctions } from "../../../i18n/i18n-types";
import { toolPresenters } from "../tool-presenters";

const LL = {
  preview_added_lines_unavailable: (n: number) =>
    `${n} added lines unavailable`,
  preview_diff_details_unavailable: () => "Diff details unavailable",
  preview_removed_lines_unavailable: (n: number) =>
    `${n} removed lines unavailable`,
  preview_written_snapshot_label: () => "Written content snapshot",
  tool_diff_label: () => "Diff",
  tool_summary_new_file: () => "new file",
} as unknown as TranslationFunctions;

describe("writeFile presenter", () => {
  it("keeps the written snapshot when historical diff hunks are missing", () => {
    const output = toolPresenters.writeFile.output?.(
      {
        success: true,
        diffStat: {
          added: 2,
          removed: 184,
          isNew: false,
          isBinary: false,
          truncated: false,
        },
      },
      {
        path: "RAG产品指南_优化版.md",
        content: "# RAG 产品指南\n\n正文不应该被当成 context diff 展示\n",
      },
      "output-available",
      {
        LL,
        toolCallId: "call-old",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain('data-diff-line-kind="removed"');
    expect(html).toContain('data-diff-line-kind="added"');
    expect(html).toContain("184 removed lines unavailable");
    expect(html).toContain("2 added lines unavailable");
    expect(html).toContain('data-written-snapshot="true"');
    expect(html).toContain("Written content snapshot");
    expect(html).toContain("正文不应该被当成 context diff 展示");
  });

  it("renders diff hunks without an inner bordered wrapper", () => {
    const output = toolPresenters.writeFile.output?.(
      {
        success: true,
        diffStat: {
          added: 1,
          removed: 1,
          isNew: false,
          isBinary: false,
          truncated: false,
          hunks: [
            { kind: "context", value: "# Title\n", lineCount: 1 },
            { kind: "removed", value: "old line\n", lineCount: 1 },
            { kind: "added", value: "new line\n", lineCount: 1 },
          ],
        },
      },
      {
        path: "RAG产品指南_优化版.md",
        content: "# Title\nnew line\n",
      },
      "output-available",
      {
        LL,
        toolCallId: "call-with-hunks",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain('data-diff-line-kind="removed"');
    expect(html).toContain('data-diff-line-kind="added"');
    expect(html).not.toContain(">Diff<");
    expect(html).not.toContain(
      "rounded-md border border-border bg-background/40 font-mono",
    );
  });
});
