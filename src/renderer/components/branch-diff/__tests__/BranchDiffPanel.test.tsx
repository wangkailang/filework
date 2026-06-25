import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const branchDiffState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  data: null as Record<string, unknown> | null,
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      branch_diff_compareBase: () => "Compare against",
      branch_diff_empty: () => "No changes",
      branch_diff_exec_failed: () => "git command failed",
      branch_diff_filterFiles: () => "Filter files...",
      branch_diff_no_base: () => "Base not found",
      branch_diff_not_git: () => "Not a git repo",
      branch_diff_open: () => "View branch changes",
      branch_diff_refresh: () => "Refresh",
      branch_diff_singleFileHint: () =>
        "Showing one changed file at a time. Select a file on the left to switch.",
      branch_diff_title: (head: string, base: string) => `${head} vs ${base}`,
      branch_diff_toggleTree: () => "File tree",
      preview_diff_truncated: () => "Diff truncated",
      preview_binary_skipped: () => "Binary file, diff skipped",
      preview_no_changes: () => "No changes",
      tool_diff_label: () => "Diff",
    },
  }),
}));

vi.mock("../useBranchDiff", () => ({
  useBranchDiff: (options: Record<string, unknown>) => {
    branchDiffState.calls.push(options);
    return {
      data: branchDiffState.data,
      error: null,
      loading: false,
      refresh: vi.fn(),
    };
  },
}));

import { BranchDiffPanel } from "../BranchDiffPanel";

const branchDiffData = () => ({
  base: "4955b69",
  baseBranch: "pc-test",
  baseRef: "origin/pc-test",
  files: [
    {
      added: 1,
      hunks: [
        {
          kind: "context",
          lineCount: 1,
          value: "@@ -95,3 +95,3 @@\n",
        },
        {
          kind: "context",
          lineCount: 1,
          oldStart: 95,
          newStart: 95,
          value: "const stable = true;\n",
        },
        {
          kind: "removed",
          lineCount: 1,
          oldStart: 96,
          value: "const count = 3;\n",
        },
        {
          kind: "added",
          lineCount: 1,
          newStart: 96,
          value: "const count = 4;\n",
        },
      ],
      isBinary: false,
      path: "src/example.ts",
      removed: 1,
      status: "modified",
    },
    {
      added: 1,
      hunks: [
        {
          kind: "context",
          lineCount: 1,
          value: "@@ -1,1 +1,1 @@\n",
        },
        {
          kind: "added",
          lineCount: 1,
          newStart: 1,
          value: "const second = true;\n",
        },
      ],
      isBinary: false,
      path: "src/second.ts",
      removed: 0,
      status: "added",
    },
  ],
  head: "29f4544",
  headBranch: "feature/example",
  totalAdded: 1,
  totalRemoved: 1,
  truncated: true,
});

describe("BranchDiffPanel", () => {
  beforeEach(() => {
    branchDiffState.calls = [];
    branchDiffState.data = null;
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses a controlled compare base when provided by the dock host", () => {
    renderToStaticMarkup(
      <BranchDiffPanel
        workspaceRoot="/tmp/workspace"
        currentBranch="feature/current"
        baseBranch="pc-test"
        onBaseBranchChange={vi.fn()}
        invalidator={1}
      />,
    );

    expect(branchDiffState.calls.at(-1)).toMatchObject({
      baseBranch: "pc-test",
      currentBranch: "feature/current",
      invalidator: 1,
      path: "/tmp/workspace",
    });
  });

  it("renders one compact diff file at a time with a left file panel", () => {
    branchDiffState.data = branchDiffData();

    const html = renderToStaticMarkup(
      <BranchDiffPanel workspaceRoot="/tmp/workspace" baseBranch="pc-test" />,
    );

    expect(html).toContain('data-branch-diff-file-tree="true"');
    expect(html).toContain('data-branch-diff-file="true"');
    expect(html).toContain('data-branch-diff-code="true"');
    expect(html).toContain('data-diff-density="branch"');
    expect(html).toContain("unmodified lines");
    expect(html.match(/data-branch-diff-file="true"/g)).toHaveLength(1);
    expect(html.match(/data-branch-diff-tree-file="true"/g)).toHaveLength(2);
    expect(html).toContain("stable = true");
    expect(html).not.toContain("second = true");
    expect(html).toContain(
      "Showing one changed file at a time. Select a file on the left to switch.",
    );
    expect(html).not.toContain("Diff truncated");
  });

  it("switches the visible diff when a file is selected from the left panel", async () => {
    branchDiffState.data = branchDiffData();
    const parsed = parseHTML("<!doctype html><div id='root'></div>");
    const domWindow = parsed.window as unknown as Window & {
      Event: typeof Event;
      HTMLElement: typeof HTMLElement;
    };
    Object.assign(domWindow, {
      filework: {
        local: {
          listBranches: vi.fn().mockResolvedValue([]),
        },
      },
    });
    vi.stubGlobal("window", domWindow);
    vi.stubGlobal("document", parsed.document);
    vi.stubGlobal("HTMLElement", domWindow.HTMLElement);
    vi.stubGlobal("Event", domWindow.Event);
    vi.stubGlobal("navigator", domWindow.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const container = parsed.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <BranchDiffPanel
            workspaceRoot="/tmp/workspace"
            baseBranch="pc-test"
          />,
        );
      });

      expect(container.textContent).toContain("stable = true");
      expect(container.textContent).not.toContain("second = true");

      const fileButtons = parsed.document.querySelectorAll(
        '[data-branch-diff-tree-file="true"]',
      );
      await act(async () => {
        fileButtons[1]?.dispatchEvent(
          new domWindow.Event("click", { bubbles: true }),
        );
      });

      expect(container.textContent).toContain("second = true");
      expect(container.textContent).not.toContain("stable = true");
    } finally {
      act(() => root.unmount());
    }
  });
});
