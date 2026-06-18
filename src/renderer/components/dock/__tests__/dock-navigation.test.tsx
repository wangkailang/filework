import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      dock_diff: () => "差异",
      dock_menu: () => "打开停靠面板",
      dock_preview: () => "预览",
      dock_search: () => "搜索",
      dock_subagent: () => "子 agent",
      dock_trash: () => "回收站",
      dock_web: () => "网页",
      preview_exitFullscreen: () => "退出全屏",
      preview_fullscreen: () => "全屏",
      session_close: () => "关闭",
      session_empty: () => "暂无历史对话",
    },
  }),
}));

vi.mock("../../branch-diff/BranchDiffPanel", () => ({
  BranchDiffPanel: () => <div data-branch-diff-panel="true" />,
}));

vi.mock("../../browser/BrowserPanel", () => ({
  BrowserPanel: () => <div data-browser-panel="true" />,
}));

vi.mock("../../chat/SubagentTracePanel", () => ({
  SubagentTracePanel: () => <div data-subagent-trace-panel="true" />,
}));

vi.mock("../../file-preview/FilePreviewPanel", () => ({
  FilePreviewPanel: () => <div data-file-preview-panel="true" />,
}));

vi.mock("../SearchPanel", () => ({
  SearchPanel: () => <div data-search-panel="true" />,
}));

vi.mock("../TrashPanel", () => ({
  TrashPanel: () => <div data-trash-panel="true" />,
}));

import { ContextDock } from "../ContextDock";
import { DockShortcut } from "../DockMenu";

const installDom = () => {
  const { document, window } = parseHTML(
    "<!doctype html><html><body></body></html>",
  );

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("MouseEvent", window.MouseEvent);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return document;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dock navigation chrome", () => {
  it("renders shortcut hints as separated lightweight keycaps in the dock menu", () => {
    const document = installDom();
    const html = renderToStaticMarkup(
      <DockShortcut
        active={true}
        dimmed={false}
        shortcut="⇧⌘P"
        tab="preview"
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    const previewShortcut = container.querySelector(
      '[data-dock-shortcut="preview"]',
    );

    expect(previewShortcut).toBeTruthy();
    expect(previewShortcut?.textContent).toBe("⇧⌘P");
    expect(previewShortcut?.className).toContain("justify-end");
    expect(previewShortcut?.className).toContain("font-mono");
    expect(previewShortcut?.className).not.toContain("rounded");
    expect(previewShortcut?.className).not.toContain("border");
    expect(previewShortcut?.className).not.toContain("bg-");
    expect(previewShortcut?.className).not.toContain("shadow");
    expect(previewShortcut?.className).not.toContain("ring");

    const keys = Array.from(previewShortcut?.querySelectorAll("kbd") ?? []);
    expect(keys.map((key) => key.textContent)).toEqual(["⇧", "⌘", "P"]);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key.className).toContain("rounded");
      expect(key.className).toContain("border");
      expect(key.className).toContain("bg-");
      expect(key.className).toContain("text-[10px]");
    }
    expect(keys[2]?.className).toContain("font-semibold");
  });

  it("renders dock tabs with icons and compact pill styling", () => {
    const html = renderToStaticMarkup(
      <ContextDock
        mode="split"
        width={420}
        activeTab="preview"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        onWidthChange={vi.fn()}
        onCommitWidth={vi.fn()}
        railWidth={56}
        railCollapsed={false}
        filePath={null}
        url={null}
        subagentSel={null}
        workspaceRoot="/tmp/workspace"
        currentBranch="main"
        diffInvalidator={0}
        isGitRepo={true}
      />,
    );

    expect(html).toContain('data-dock-tab="preview"');
    expect(html).toContain('data-dock-tab-icon="preview"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("rounded-md");
    expect(html).toContain("gap-1.5");
  });
});
