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
  tool_stderr: () => "stderr",
  tool_submit_coverage: () => "Coverage",
  tool_submit_evidence: () => "Evidence",
  tool_submit_failure: () => "Failure reason",
  tool_submit_findings: () => "Key findings",
  tool_submit_missing: () => "Missing",
  tool_submit_noResult: () => "No result",
  tool_submit_partial: () => "Partial result",
  tool_submit_complete: () => "Complete result",
  tool_summary_exitCode: (n: number) => `exit ${n}`,
  tool_summary_more: (n: number) => `${n} more lines`,
  tool_summary_new_file: () => "new file",
  tool_webFetch_content: () => "Page content",
  tool_webFetch_empty: () => "No page content extracted",
  tool_webFetch_matches: (n: number) => `${n} matches`,
  tool_webFetch_pages: (n: number) => `${n} pages`,
  tool_webFetch_truncated: () => "Content truncated",
} as unknown as TranslationFunctions;

describe("runCommand presenter", () => {
  it("keeps command summaries lower contrast than assistant prose", () => {
    const summary = toolPresenters.runCommand.summary?.(
      { command: "python3 dragon-boat-poster.py" },
      { exitCode: 1 },
      "output-available",
      {
        LL,
        toolCallId: "call-command",
      },
    );

    const html = renderToStaticMarkup(summary);

    expect(html).toContain("text-foreground/65");
    expect(html).toContain("text-status-error/70");
    expect(html).not.toContain("text-foreground/80");
    expect(html).not.toContain("text-red-400");
  });

  it("renders command recovery hints in the expanded output", () => {
    const output = toolPresenters.runCommand.output?.(
      {
        stderr:
          "error: could not lock config file /Users/kailang/.gitconfig: Operation not permitted\n",
        exitCode: 255,
        displayHint:
          "Command sandbox blocked a file-write policy violation outside the workspace. The agent can retry with elevated permissions after approval.",
      },
      { command: "git config --global user.email test@example.com" },
      "output-error",
      {
        LL,
        toolCallId: "call-command-hint",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain("data-command-hint");
    expect(html).toContain("file-write policy");
    expect(html).toContain("outside the workspace");
  });
});

describe("writeFile presenter", () => {
  it("uses subdued diff stat colors in the folded summary", () => {
    const summary = toolPresenters.writeFile.summary?.(
      {
        path: "dragon-boat-poster.py",
        content: "print('poster')\n",
      },
      {
        success: true,
        diffStat: {
          added: 3,
          removed: 1,
          isNew: false,
          isBinary: false,
          truncated: false,
        },
      },
      "output-available",
      {
        LL,
        toolCallId: "call-write-summary",
      },
    );

    const html = renderToStaticMarkup(summary);

    expect(html).toContain("text-status-success/75");
    expect(html).toContain("text-status-error/70");
    expect(html).not.toContain("text-emerald-500");
    expect(html).not.toContain("text-red-400");
  });

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

  it("renders write diffs with branch-style code rows", () => {
    const output = toolPresenters.writeFile.output?.(
      {
        success: true,
        diffStat: {
          added: 1,
          removed: 0,
          isNew: false,
          isBinary: false,
          truncated: false,
          hunks: [
            {
              kind: "context",
              value: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n",
              lineCount: 7,
              newStart: 1,
              oldStart: 1,
            },
            {
              kind: "added",
              value: "expect(html).toContain('ok');\n",
              lineCount: 1,
              newStart: 8,
            },
          ],
        },
      },
      {
        path: "src/renderer/components/ai-elements/__tests__/tool.test.tsx",
        content: "line 1\nline 2\n",
      },
      "output-available",
      {
        LL,
        toolCallId: "call-branch-style-write-diff",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain('data-write-file-diff-code="true"');
    expect(html).toContain('data-diff-density="branch"');
    expect(html).toContain("bg-surface-sunken");
    expect(html).toContain("max-h-72");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("text-[11px]");
    expect(html).toContain("leading-5");
    expect(html).toContain("unmodified lines");
    expect(html).not.toContain("grid-cols-[3rem_3rem_1.5rem_max-content]");
  });
});

describe("webSearch presenter", () => {
  it("renders multiple search results as clickable list items", () => {
    const output = toolPresenters.webSearch.output?.(
      {
        answer: null,
        results: [
          {
            title: "Zustand vs Redux Toolkit",
            url: "https://example.com/zustand-redux",
            snippet: "A comparison of React state managers.",
            score: 0.9,
          },
          {
            title: "Jotai state guide",
            url: "https://example.com/jotai",
            snippet: "Atomic state for React.",
            score: 0.8,
          },
        ],
      },
      { query: "react state managers" },
      "output-available",
      {
        LL,
        toolCallId: "call-search",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain("<ol");
    expect(html).toContain("<li");
    expect(html).toContain('href="https://example.com/zustand-redux"');
    expect(html).toContain('href="https://example.com/jotai"');
    expect(html).toContain("Zustand vs Redux Toolkit");
    expect(html).toContain("A comparison of React state managers.");
  });
});

describe("webFetch presenter", () => {
  it("renders page metadata and readable content instead of raw JSON", () => {
    const output = toolPresenters.webFetch.output?.(
      {
        status: 200,
        statusText: "OK",
        url: "https://example.com/docs/getting-started",
        contentType: "text/html; charset=utf-8",
        title: "Getting started",
        excerpt: "A concise introduction to the product.",
        markdown: "# Install\n\nRun the setup command and open the app.",
        raw: "",
        truncated: true,
        pages: 3,
        matchedChunks: [{ index: 1 }, { index: 4 }],
      },
      {
        url: "https://example.com/docs/getting-started",
        query: "installation",
      },
      "output-available",
      {
        LL,
        toolCallId: "call-web-fetch",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain('data-web-fetch-output="true"');
    expect(html).toContain('data-web-fetch-truncated="true"');
    expect(html).toContain("200 OK");
    expect(html).toContain("Getting started");
    expect(html).toContain("A concise introduction to the product.");
    expect(html).toContain("Run the setup command and open the app.");
    expect(html).toContain("3 pages");
    expect(html).toContain("2 matches");
    expect(html).not.toContain("&quot;markdown&quot;");
  });
});

describe("submitSubagentResult presenter", () => {
  it("renders the submitted research as findings and evidence", () => {
    const output = toolPresenters.submitSubagentResult.output?.(
      { success: true, accepted: true },
      {
        status: "partial",
        coverage: ["pricing", "security"],
        findings: [
          {
            claim: "The team plan starts at $20 per member.",
            evidence: ["Pricing page lists $20 per member per month."],
          },
        ],
        evidence: ["https://example.com/pricing"],
        missing: ["Enterprise contract minimum"],
        failureReason: "The sales form requires a company email.",
      },
      "output-available",
      {
        LL,
        toolCallId: "call-submit-result",
      },
    );

    const html = renderToStaticMarkup(output);

    expect(html).toContain('data-subagent-result="partial"');
    expect(html).toContain("Partial result");
    expect(html).toContain("pricing");
    expect(html).toContain("The team plan starts at $20 per member.");
    expect(html).toContain("Pricing page lists $20 per member per month.");
    expect(html).toContain("https://example.com/pricing");
    expect(html).toContain("Enterprise contract minimum");
    expect(html).toContain("The sales form requires a company email.");
    expect(html).not.toContain("&quot;findings&quot;");
  });
});

describe("searchFiles presenter", () => {
  it("shows the search query in the folded summary", () => {
    const summary = toolPresenters.searchFiles?.summary?.(
      {
        query: "words_alpha",
        path: "/Users/kailang/Desktop/未命名文件夹/一周99(1)",
        limit: 20,
      },
      {
        results: [
          {
            path: "/Users/kailang/Desktop/未命名文件夹/一周99(1)/words_alpha.txt",
            relPath: "words_alpha.txt",
            name: "words_alpha.txt",
            size: 4234910,
          },
        ],
        count: 1,
        totalMatched: 1,
        truncated: false,
      },
      "output-available",
      {
        LL,
        toolCallId: "call-search-files",
        workspacePath: "/Users/kailang/Desktop/未命名文件夹/一周99(1)",
      },
    );

    const html = renderToStaticMarkup(summary);

    expect(html).toContain("words_alpha");
    expect(html).toContain("text-foreground/65");
    expect(html).not.toContain("/Users/kailang/Desktop");
  });
});

describe("browser presenters", () => {
  it("shows origin, action, target and active tab without leaking typed text or URL credentials", () => {
    const summary = toolPresenters.browserType.summary?.(
      {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "e7",
        text: "super-secret-value",
      },
      {
        tabId: "tab-1",
        url: "https://user:pass@example.com/account?view=profile",
        elements: [{ ref: "e7", name: "Search", tag: "input", visible: true }],
      },
      "output-available",
      { LL, toolCallId: "call-browser" },
    );
    const input = toolPresenters.browserType.input?.(
      {
        tabId: "tab-1",
        navigationId: "nav-1",
        snapshotId: "snap-1",
        ref: "e7",
        text: "super-secret-value",
      },
      { LL, toolCallId: "call-browser" },
    );

    const html = renderToStaticMarkup(
      <>
        {summary}
        {input}
      </>,
    );
    expect(html).toContain("https://example.com");
    expect(html).toContain("type");
    expect(html).toContain("Search · e7");
    expect(html).toContain("tab-1");
    expect(html).toContain("done");
    expect(html).not.toContain("super-secret-value");
    expect(html).not.toContain("user:pass");
  });
});
