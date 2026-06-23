import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const branchDiffState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
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
      branch_diff_title: (head: string, base: string) => `${head} vs ${base}`,
      branch_diff_toggleTree: () => "File tree",
      preview_diff_truncated: () => "Diff truncated",
    },
  }),
}));

vi.mock("../useBranchDiff", () => ({
  useBranchDiff: (options: Record<string, unknown>) => {
    branchDiffState.calls.push(options);
    return {
      data: null,
      error: null,
      loading: false,
      refresh: vi.fn(),
    };
  },
}));

import { BranchDiffPanel } from "../BranchDiffPanel";

describe("BranchDiffPanel", () => {
  beforeEach(() => {
    branchDiffState.calls = [];
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
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
});
